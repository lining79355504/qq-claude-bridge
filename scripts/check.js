/**
 * 启动前自检：不连接 QQ 或调用模型，只检查配置、依赖与 Claude CLI。
 *
 *   npm run check
 */
import { existsSync, statSync } from 'node:fs';

const ok = (m) => console.log(`  ✅ ${m}`);
const bad = (m) => console.log(`  ❌ ${m}`);

let failed = 0;

console.log('\n[1/4] 配置文件');
if (!existsSync('.env')) {
  bad('.env 不存在，请先 cp .env.example .env 并填写');
  failed++;
} else {
  ok('.env 存在');
}

let config;
let validateConfig;
let describeScope;
try {
  ({ describeScope } = await import('../src/guard.js'));
  ({ config, validateConfig } = await import('../src/config.js'));
  validateConfig();
  ok('配置校验通过');
  ok(`工作目录: ${config.workspace}`);
  ok(`权限模式: ${config.permissionMode}`);
  ok(`工单数据库: ${config.ticketDbPath}`);
  ok(`定时任务并发: ${config.scheduleConcurrency}；推送并发: ${config.scheduleDeliveryConcurrency}；时区: ${config.scheduleTimezone}`);
  ok(`单次轮数上限: 工单 ${config.maxTurns}，定时任务 ${config.scheduleMaxTurns}`);
  ok(`白名单人数: ${config.allowedUserIds.length}`);
  ok(`接入方式: ${config.transport}`);
  ok(config.transport === 'official' ? `机器人 AppID: ${config.appId}` : `机器人 QQ: ${config.botQqId || '未绑定'}`);
  ok(`只读放行工具: ${config.readOnlyTools.length} 个`);
  ok(`目录围栏: ${describeScope(config.allowedPaths)}`);
} catch (err) {
  bad(err.message);
  failed++;
}

console.log('\n[2/4] 工作目录');
try {
  if (!config || !statSync(config.workspace).isDirectory()) throw new Error('工作目录不可用');
  ok('目录存在');
} catch (error) { bad(error.message); failed++; }

console.log('\n[3/4] 依赖');
for (const dep of [
  'ws',
  '@tencent-connect/qqbot-connector',
  '@anthropic-ai/claude-agent-sdk',
  'dotenv',
  'node:sqlite',
]) {
  try {
    await import(dep);
    ok(dep);
  } catch (err) {
    bad(`${dep} 加载失败: ${err.message}`);
    failed++;
  }
}

console.log('\n[4/4] Claude Code CLI（不验证登录态）');
try {
  const { execFileSync } = await import('node:child_process');
  const out = execFileSync('claude', ['--version'], { encoding: 'utf8' }).trim();
  ok(`claude CLI: ${out}`);
} catch {
  bad('找不到 claude 命令，Claude Code 可能没装或不在 PATH');
  failed++;
}

console.log('');
if (failed > 0) {
  console.log(`检查未通过，共 ${failed} 项问题。\n`);
  process.exit(1);
}
console.log('全部通过，可以 npm start 了。\n');
