import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFileSync, readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { createHash, randomBytes } from 'node:crypto';
import { createGameHandler } from '../supabase/functions/game/handler.ts';

const execute = promisify(execFile);
const container = `btc-backend-test-${process.pid}`;
const origin = 'https://woohyun-jang.github.io';
const quote = value => value == null ? 'null' : `'${String(value).replaceAll("'", "''")}'`;
const digest = token => createHash('sha256').update(token).digest('hex');
const token = () => randomBytes(32).toString('base64url');
const sql = async statement => (await execute('docker', ['exec', '-i', container, 'psql', '-U', 'postgres', '-qAt', '-v', 'ON_ERROR_STOP=1', '-c', statement], { maxBuffer: 2_000_000 })).stdout.trim();
const request = async (action, sessionToken, values = {}) => action === 'ranking' ? JSON.parse(await sql(`set role service_role; select public.game_ranking(${quote(values.classPrefix)});`)) : JSON.parse(await sql(`set role service_role; select public.game_request(${quote(action)}, ${quote(sessionToken ? digest(sessionToken) : null)}, ${quote(values.studentId)}, ${quote(values.name)}, ${values.stage ?? 'null'}, ${quote(values.answer)});`));
const entry = async (studentId, name = '김학생') => { const sessionToken = token(); const data = await request('enter', sessionToken, { studentId, name }); return { sessionToken, data }; };
const answers = ['나다라가', '23', '4', '행동감정', '2', '3', '13', '900000', '2', '다라가나'];

before(async () => {
  await execute('docker', ['run', '--rm', '-d', '--name', container, '--network', 'none', '-e', 'POSTGRES_HOST_AUTH_METHOD=trust', 'postgres:17-alpine', '-c', 'wal_level=logical']);
  for (let retry = 0; retry < 40; retry++) {
    try { await execute('docker', ['exec', container, 'pg_isready', '-h', '127.0.0.1', '-U', 'postgres']); break; }
    catch { if (retry === 39) throw new Error('PostgreSQL did not become ready'); await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  await sql('create role anon; create role authenticated; create role service_role bypassrls; create publication supabase_realtime;');
  const directory = new URL('../supabase/migrations/', import.meta.url);
  for (const name of readdirSync(directory).filter(name => name.endsWith('.sql')).sort()) await sql(readFileSync(new URL(name, directory), 'utf8'));
});
after(async () => { await execute('docker', ['rm', '-f', container]).catch(() => {}); });

test('one attempt per student: duplicate enter preserves identity and start', async () => {
  const { sessionToken, data } = await entry('10001');
  const resumed = await request('enter', sessionToken, { studentId: '10001', name: '다른이름' });
  assert.equal(resumed.state.startedAt, data.state.startedAt);
  assert.equal(resumed.state.name, '김학생');
  assert.equal(resumed.state.nextStage, 0);
  assert.equal(resumed.state.room.answer, undefined);
  assert.equal(resumed.state.room.explanation, undefined);
  assert.equal(resumed.state.room.hint, undefined);
  assert.deepEqual(resumed.state.recaps, []);
  await assert.rejects(request('enter', token(), { studentId: '10001', name: '김학생' }), /IN_PROGRESS/);
});

test('concurrent conflicting entries produce one owner', async () => {
  const sessions = [token(), token(), token(), token()];
  const results = await Promise.allSettled(sessions.map(session => request('enter', session, { studentId: '10002', name: '이학생' })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.equal(results.filter(result => result.status === 'rejected' && /IN_PROGRESS/.test(result.reason.message)).length, 3);
  assert.equal(await sql("select count(*) from public.game_attempts where student_id='10002'"), '1');
});

test('concurrent matching entries and answers are idempotent', async () => {
  const sessionToken = token();
  const entered = await Promise.all(Array.from({ length: 4 }, () => request('enter', sessionToken, { studentId: '10003', name: '박학생' })));
  assert.equal(new Set(entered.map(result => result.state.startedAt)).size, 1);
  const answered = await Promise.all(Array.from({ length: 4 }, () => request('answer', sessionToken, { stage: 0, answer: '나, 다-라 가' })));
  assert.ok(answered.every(result => result.correct && result.state.nextStage === 1));
  assert.equal(answered[0].state.recaps[0].answer, answers[0]);
});

test('wrong answers and future stages cannot advance', async () => {
  const { sessionToken } = await entry('10004');
  const wrong = await request('answer', sessionToken, { stage: 0, answer: '오답' });
  assert.equal(wrong.correct, false);
  assert.equal(wrong.state.nextStage, 0);
  await assert.rejects(request('answer', sessionToken, { stage: 1, answer: answers[1] }), /STAGE_MISMATCH/);
  await request('answer', sessionToken, { stage: 0, answer: answers[0] });
  await assert.rejects(request('answer', sessionToken, { stage: 0, answer: '오답' }), /STAGE_MISMATCH/);
});

test('hints record each stage once, allow solved stages and reject future stages', async () => {
  const { sessionToken } = await entry('10005');
  const results = await Promise.all(Array.from({ length: 4 }, () => request('hint', sessionToken, { stage: 0 })));
  assert.ok(results.every(result => result.hint && result.state.hints.length === 1));
  await request('answer', sessionToken, { stage: 0, answer: answers[0] });
  assert.deepEqual((await request('hint', sessionToken, { stage: 0 })).state.hints, [0]);
  await assert.rejects(request('hint', sessionToken, { stage: 2 }), /STAGE_MISMATCH/);
});

test('tenth answer completes and publishes only one immutable ranking', async () => {
  const { sessionToken, data } = await entry('10006');
  await request('hint', sessionToken, { stage: 0 });
  for (let stage = 0; stage < 9; stage++) await request('answer', sessionToken, { stage, answer: answers[stage] });
  const results = await Promise.all(Array.from({ length: 4 }, () => request('answer', sessionToken, { stage: 9, answer: answers[9] })));
  const final = results[0].state;
  assert.ok(results.every(result => result.correct && result.state.nextStage === 10 && result.state.completedAt === final.completedAt && result.state.elapsedMs === final.elapsedMs));
  assert.equal(final.room, null);
  assert.equal(final.recaps.length, 10);
  assert.ok(final.elapsedMs >= 0);
  assert.ok(Math.abs(final.elapsedMs - (Date.parse(final.completedAt) - Date.parse(data.state.startedAt))) <= 1);
  assert.equal((await request('state', sessionToken)).state.elapsedMs, final.elapsedMs);
  assert.equal((await request('enter', sessionToken, { studentId: '10006', name: '김학생' })).state.completedAt, final.completedAt);
  await assert.rejects(request('enter', token(), { studentId: '10006', name: '김학생' }), /COMPLETED/);
  await assert.rejects(request('hint', sessionToken, { stage: 1 }), /COMPLETED/);
  assert.ok((await request('hint', sessionToken, { stage: 0 })).hint);
  const ranking = await request('ranking');
  assert.equal(ranking.entries.length, 1);
  assert.deepEqual(Object.keys(ranking.entries[0]).sort(), ['completedAt', 'studentId', 'name', 'elapsedMs', 'hintsUsed', 'id'].sort());
  assert.equal(ranking.entries[0].studentId, '10006');
  assert.equal(ranking.entries[0].name, '김학생');
  assert.equal(ranking.entries[0].hintsUsed, 1);
  assert.equal(ranking.entries[0].elapsedMs, final.elapsedMs);
});

test('database validation rejects bad identities, tokens and oversized answers', async () => {
  await assert.rejects(request('enter', token(), { studentId: '1234', name: '이름' }), /INVALID_REQUEST/);
  await assert.rejects(request('enter', token(), { studentId: '10007', name: ' ' }), /INVALID_REQUEST/);
  await assert.rejects(request('enter', token(), { studentId: '10007', name: '가'.repeat(41) }), /INVALID_REQUEST/);
  await assert.rejects(sql("set role service_role; select game_request('state','raw-token')"), /INVALID_REQUEST/);
  await assert.rejects(request('state', token()), /SESSION_NOT_FOUND/);
  const { sessionToken } = await entry('10007');
  await assert.rejects(request('enter', sessionToken, { studentId: '10008', name: '이름' }), /TOKEN_IN_USE/);
  await assert.rejects(request('answer', sessionToken, { stage: 0, answer: '가'.repeat(201) }), /INVALID_REQUEST/);
  assert.equal(await sql(`select token_hash from game_attempts where student_id='10007'`), digest(sessionToken));
  assert.ok(!await sql(`select row_to_json(a)::text from game_attempts a where student_id='10007'`).then(row => row.includes(sessionToken)));
});

test('anon and authenticated can only read public leaderboard', async () => {
  for (const role of ['anon', 'authenticated']) {
    assert.equal(await sql(`set role ${role}; select count(*) from game_leaderboard`), '1');
    await assert.rejects(sql(`set role ${role}; select * from game_attempts`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select * from game_rooms`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select game_request('ranking')`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; select game_state(null::game_attempts)`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; insert into game_leaderboard(student_id,name,elapsed_ms,hints_used,completed_at) values('99999','위조',0,0,now())`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; update game_leaderboard set elapsed_ms=0`), /permission denied/);
    await assert.rejects(sql(`set role ${role}; delete from game_leaderboard`), /permission denied/);
  }
  assert.equal(await sql("select tablename from pg_publication_tables where pubname='supabase_realtime'"), 'game_leaderboard');
});

test('ranking returns top 100 with deterministic ties', async () => {
  await sql("insert into game_leaderboard(id,student_id,name,elapsed_ms,hints_used,completed_at) select ('00000000-0000-0000-0000-' || lpad(i::text,12,'0'))::uuid,'99999','이학생',1000000,0,'2026-01-01'::timestamptz from generate_series(1,105) i");
  const result = await request('ranking');
  assert.equal(result.entries.length, 100);
  assert.ok(result.entries[0].elapsedMs < 1000000);
  assert.equal(result.entries[1].id, '00000000-0000-0000-0000-000000000001');
  assert.equal(result.entries[99].id, '00000000-0000-0000-0000-000000000099');
});


test('class ranking filters before limiting and lists classes outside global top 100', async () => {
  await sql("insert into game_leaderboard(student_id,name,elapsed_ms,hints_used,completed_at) values('10201','다른 반',2000000,0,now()),('10301','또 다른 반',3000000,0,now())");
  const result = await request('ranking', null, { classPrefix: '102' });
  assert.equal(result.entries.length, 1);
  assert.equal(result.entries[0].studentId, '10201');
  assert.ok(result.classes.includes('102') && result.classes.includes('103'));
  assert.equal((await request('ranking', null, { classPrefix: '104' })).entries.length, 0);
  await assert.rejects(request('ranking', null, { classPrefix: '1%' }), /INVALID_REQUEST/);
  await assert.rejects(sql("set role anon; select public.game_ranking(null)"), /permission denied/);
});

test('HTTP contract validates inputs, masks database failures and sets CORS', async () => {
  let rpcCount = 0;
  let lastArgs;
  const handler = createGameHandler({ rpc: async (name, args) => { rpcCount++; lastArgs = args; assert.ok(['game_request', 'game_ranking'].includes(name)); return { data: { state: { nextStage: 0 } }, error: null }; } }, origin);
  const invoke = body => handler(new Request('https://local.test/functions/v1/game', { method: 'POST', headers: { Origin: origin }, body: JSON.stringify(body) }));
  const sessionToken = token();
  const valid = await invoke({ action: 'enter', studentId: '12345', name: ' 김학생 ', sessionToken });
  assert.equal(valid.status, 200);
  assert.equal(valid.headers.get('access-control-allow-origin'), origin);
  assert.equal(lastArgs.p_token_hash, digest(sessionToken));
  assert.equal(lastArgs.p_name, '김학생');
  assert.ok(!JSON.stringify(lastArgs).includes(sessionToken));
  for (const body of [null, [], { action: 'reset' }, { action: 'state', sessionToken: 'invalid' }, { action: 'enter', studentId: 12345, name: '이름', sessionToken }, { action: 'answer', sessionToken, stage: 1.5, answer: '2' }, { action: 'answer', sessionToken, stage: 0, answer: 2 }]) assert.equal((await invoke(body)).status, 400);
  assert.equal(rpcCount, 1);
  for (const classPrefix of ['1%', '10', 102, '１０２']) assert.equal((await invoke({ action: 'ranking', classPrefix })).status, 400);
  assert.equal(rpcCount, 1);
  assert.equal((await invoke({ action: 'ranking', classPrefix: '102' })).status, 200);
  assert.deepEqual(lastArgs, { p_class_prefix: '102' });
  assert.equal((await invoke({ action: 'ranking' })).status, 200);
  assert.deepEqual(lastArgs, { p_class_prefix: null });
  const denied = await handler(new Request('https://local.test', { method: 'OPTIONS', headers: { Origin: 'https://wrong.test' } }));
  assert.equal(denied.status, 403);
  assert.equal(denied.headers.get('access-control-allow-origin'), null);
  assert.equal((await handler(new Request('https://local.test', { method: 'OPTIONS', headers: { Origin: origin } }))).status, 204);
  assert.equal((await handler(new Request('https://local.test'))).status, 405);
  assert.equal((await handler(new Request('https://local.test', { method: 'POST', body: '{' }))).status, 400);
  const failing = createGameHandler({ rpc: async () => ({ data: null, error: { code: 'XX000', message: 'private SQL detail' } }) }, origin);
  const failure = await failing(new Request('https://local.test', { method: 'POST', body: JSON.stringify({ action: 'ranking' }) }));
  assert.equal(failure.status, 500);
  assert.deepEqual(await failure.json(), { error: { code: 'SERVER_ERROR', message: '서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요.' } });
});
