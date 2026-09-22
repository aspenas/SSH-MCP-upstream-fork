import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import ssh2 from 'ssh2';

const { Server: SSHServer } = ssh2;

const entrypoint = fileURLToPath(new URL('../build/index.js', import.meta.url));

function assertToolError(result, message) {
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, message);
}

test('MCP server over stdio', { timeout: 30_000 }, async (t) => {
  const client = new Client({ name: 'ssh-mcp-test', version: '1.0.0' }, { capabilities: {} });
  const transport = new StdioClientTransport({ command: process.execPath, args: [entrypoint] });
  t.after(() => client.close());
  await client.connect(transport);

  await t.test('initializes and exposes the SSH and Ubuntu tools', async () => {
    assert.equal(client.getServerVersion().name, 'MCP SSH Server');
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    assert.equal(new Set(names).size, names.length);
    for (const name of [
      'ssh_connect', 'ssh_exec', 'ssh_upload_file', 'ssh_download_file',
      'ssh_list_files', 'ssh_disconnect', 'ubuntu_nginx_control',
    ]) {
      assert.ok(names.includes(name), `Missing tool: ${name}`);
    }
    for (const tool of tools) {
      assert.equal(tool.inputSchema.type, 'object');
    }
  });

  await t.test('rejects a connection without credentials before opening a socket', async () => {
    const result = await client.callTool({
      name: 'ssh_connect', arguments: { host: 'unused.invalid', username: 'test' },
    });
    assertToolError(result, /Either password or privateKeyPath must be provided/);
  });

  await t.test('reports missing connections for SSH and Ubuntu commands', async () => {
    for (const [name, args] of [
      ['ssh_exec', { command: 'echo test' }],
      ['ssh_upload_file', { localPath: 'unused', remotePath: 'unused' }],
      ['ssh_download_file', { localPath: 'unused', remotePath: 'unused' }],
      ['ssh_list_files', { remotePath: 'unused' }],
      ['ssh_disconnect', {}],
      ['ubuntu_nginx_control', { action: 'status' }],
    ]) {
      const result = await client.callTool({
        name, arguments: { connectionId: 'missing', ...args },
      });
      assertToolError(result, /No active SSH connection with ID: missing/);
    }
  });

  await t.test('rejects an unknown tool through the protocol', async () => {
    await assert.rejects(
      client.callTool({ name: 'unknown_tool', arguments: {} }),
      /Unknown tool: unknown_tool/,
    );
  });

  await t.test('connects, runs a command, and disconnects from a local SSH server', async (t) => {
    const { privateKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      privateKeyEncoding: { type: 'pkcs1', format: 'pem' },
      publicKeyEncoding: { type: 'spki', format: 'pem' },
    });
    const connections = new Set();
    const receivedCommands = [];
    const serverErrors = [];
    const sshServer = new SSHServer({ hostKeys: [privateKey] }, (connection) => {
      connections.add(connection);
      connection.on('close', () => connections.delete(connection));
      connection.on('error', (error) => serverErrors.push(error));
      connection.on('authentication', (context) => {
        if (context.method === 'password' && context.username === 'test-user'
          && context.password === 'test-only-password') {
          context.accept();
        } else {
          context.reject(['password']);
        }
      });
      connection.on('ready', () => {
        connection.on('session', (accept) => {
          accept().on('exec', (acceptCommand, rejectCommand, info) => {
            receivedCommands.push(info.command);
            const stream = acceptCommand();
            stream.write('local SSH fixture response\n');
            stream.exit(0);
            stream.end();
          });
        });
      });
    });
    t.after(async () => {
      for (const connection of connections) connection.end();
      if (sshServer.address()) await new Promise((resolve) => sshServer.close(resolve));
    });
    await new Promise((resolve, reject) => {
      sshServer.once('error', reject);
      sshServer.listen(0, '127.0.0.1', resolve);
    });

    const connected = await client.callTool({
      name: 'ssh_connect',
      arguments: {
        host: '127.0.0.1', port: sshServer.address().port,
        username: 'test-user', password: 'test-only-password', connectionId: 'loopback',
      },
    });
    assert.notEqual(connected.isError, true);
    assert.match(connected.content[0].text, /Successfully connected/);

    const executed = await client.callTool({
      name: 'ssh_exec', arguments: { connectionId: 'loopback', command: 'test-command' },
    });
    assert.notEqual(executed.isError, true);
    assert.match(executed.content[0].text, /Exit code: 0/);
    assert.match(executed.content[0].text, /local SSH fixture response/);
    assert.deepEqual(receivedCommands, ['test-command']);

    const disconnected = await client.callTool({
      name: 'ssh_disconnect', arguments: { connectionId: 'loopback' },
    });
    assert.notEqual(disconnected.isError, true);
    assert.match(disconnected.content[0].text, /Disconnected from/);
    const afterDisconnect = await client.callTool({
      name: 'ssh_exec', arguments: { connectionId: 'loopback', command: 'test-command' },
    });
    assertToolError(afterDisconnect, /No active SSH connection with ID: loopback/);
    assert.deepEqual(serverErrors, []);
  });
});
