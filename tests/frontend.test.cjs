const { test } = require("node:test");
const assert = require("node:assert/strict");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const { chromium } = require("playwright");
const root = path.resolve(__dirname, "..");
const sql = fs.readFileSync(
  path.join(root, "supabase/migrations/20261001000000_game.sql"),
  "utf8",
);
const rooms = [
  ...sql.matchAll(
    /\((\d), '((?:[^']|'')*)'::jsonb, '((?:[^']|'')*)', '((?:[^']|'')*)', '((?:[^']|'')*)'\)/g,
  ),
].map((m) => ({
  stage: +m[1],
  room: JSON.parse(m[2].replace(/''/g, "'")),
  answer: m[3].replace(/''/g, "'"),
  hint: m[4].replace(/''/g, "'"),
  explanation: m[5].replace(/''/g, "'"),
}));
assert.equal(rooms.length, 10);

test("entry, server progress, completion lock, full public ranking and realtime UI", async (t) => {
  const server = http.createServer((req, res) => {
    const file =
      req.url === "/game-config.js" ? "game-config.js" : "index.html";
    res.setHeader(
      "Content-Type",
      file.endsWith(".js") ? "text/javascript" : "text/html",
    );
    res.end(fs.readFileSync(path.join(root, file)));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  t.after(async () => {
    await browser.close();
    await new Promise((resolve) => server.close(resolve));
  });
  const url = `http://127.0.0.1:${server.address().port}`;
  const attempts = new Map();
  let entries = [];
  const requests = [];
  const errors = [];
  let loseEntryResponse = true;
  const state = (a) => ({
    studentId: a.studentId,
    name: a.name,
    startedAt: "2026-10-01T00:00:00Z",
    serverNow: "2026-10-01T00:02:00Z",
    completedAt: a.nextStage === 10 ? "2026-10-01T00:02:00Z" : null,
    elapsedMs: 120000,
    nextStage: a.nextStage,
    hints: [...a.hints],
    recaps: rooms
      .slice(0, a.nextStage)
      .map(({ stage, answer, explanation }) => ({
        stage,
        answer,
        explanation,
      })),
    room: rooms[a.nextStage]?.room || null,
  });
  async function setup(context) {
    await context.route("**/game-config.js", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: 'window.GAME_CONFIG={supabaseUrl:"https://test.supabase.co",publishableKey:"public-test-key"};',
      }),
    );
    await context.route("https://cdn.jsdelivr.net/**", (route) =>
      route.fulfill({
        contentType: "text/javascript",
        body: `window.removedChannels=0;window.supabase={createClient:()=>({channel:()=>({on:function(type,filter,cb){window.rankEvent=cb;return this},subscribe:function(cb){setTimeout(()=>cb('SUBSCRIBED'),0);return this}}),removeChannel:()=>{window.removedChannels++}})};`,
      }),
    );
    await context.route(
      "https://test.supabase.co/functions/v1/game",
      async (route) => {
        const p = route.request().postDataJSON();
        requests.push(p);
        let result,
          status = 200;
        const fail = (code, message) => {
          status = 409;
          result = { error: { code, message } };
        };
        if (p.action === "ranking") result = { entries };
        else if (p.action === "enter") {
          let a = attempts.get(p.studentId);
          if (a && a.token !== p.sessionToken)
            fail(
              a.nextStage === 10 ? "COMPLETED" : "IN_PROGRESS",
              a.nextStage === 10
                ? "이미 완료한 학번입니다."
                : "이미 진행 중인 학번입니다.",
            );
          else {
            if (!a) {
              a = {
                studentId: p.studentId,
                name: p.name,
                token: p.sessionToken,
                nextStage: 0,
                hints: [],
              };
              attempts.set(p.studentId, a);
            }
            result = { state: state(a) };
          }
        } else {
          const a = [...attempts.values()].find(
            (a) => a.token === p.sessionToken,
          );
          assert.ok(a);
          if (p.action === "hint") {
            if (!a.hints.includes(p.stage)) a.hints.push(p.stage);
            result = { hint: rooms[p.stage].hint, state: state(a) };
          } else if (p.action === "state") result = { state: state(a) };
          else {
            const correct =
              p.answer.replace(/\s/g, "") === rooms[p.stage].answer;
            if (correct && p.stage === a.nextStage) a.nextStage++;
            if (
              a.nextStage === 10 &&
              !entries.some((e) => e.studentId === a.studentId)
            )
              entries.push({
                id: "1",
                studentId: a.studentId,
                name: a.name,
                elapsedMs: 120000,
                hintsUsed: a.hints.length,
                completedAt: state(a).completedAt,
              });
            result = { correct, state: state(a) };
          }
        }
        if (p.action === "enter" && status === 200 && loseEntryResponse) {
          loseEntryResponse = false;
          await route.abort("failed");
          return;
        }
        await route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(result),
        });
      },
    );
  }
  const context = await browser.newContext();
  await setup(context);
  const page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(url);
  async function enter(page, id, name) {
    await page.locator("#student-id").fill(id);
    await page.locator("#student-name").fill(name);
    await page.locator("#start").click();
  }
  await enter(page, "1234", "홍길동");
  assert.match(await page.locator("#entry-error").textContent(), /5자리/);
  assert.equal(requests.length, 0);
  await enter(page, "abcde", "홍길동");
  assert.equal(requests.length, 0);
  await enter(page, "00123", "");
  assert.match(await page.locator("#entry-error").textContent(), /이름/);
  const publicName = "<img src=x onerror=alert(1)>김학생";
  await enter(page, "00123", publicName);
  await page.waitForFunction(() =>
    document.querySelector("#entry-error").textContent.includes("서버에 연결"),
  );
  const firstToken = await page.evaluate(() =>
    localStorage.getItem("work-life-session:00123"),
  );
  await enter(page, "00123", publicName);
  await page.locator("#intro-dialog").waitFor({ state: "hidden" });
  const token = await page.evaluate(() =>
    localStorage.getItem("work-life-session:00123"),
  );
  assert.match(token, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(token, firstToken);
  assert.equal(attempts.size, 1);
  await page.locator("#answer").fill("틀림");
  await page.locator("#answer-form").evaluate((f) => f.requestSubmit());
  await page.waitForFunction(() =>
    document.querySelector("#feedback").textContent.includes("아직"),
  );
  assert.equal(attempts.get("00123").nextStage, 0);
  await page.locator("#hint").click();
  await page.locator("#hint-box").waitFor({ state: "visible" });
  assert.equal(attempts.get("00123").hints.length, 1);
  await page.reload();
  await enter(page, "00123", publicName);
  await page.locator("#intro-dialog").waitFor({ state: "hidden" });
  assert.equal(
    await page.evaluate(() => localStorage.getItem("work-life-session:00123")),
    token,
  );
  const other = await browser.newContext();
  await setup(other);
  const otherPage = await other.newPage();
  await otherPage.goto(url);
  await enter(otherPage, "00123", publicName);
  await otherPage.waitForFunction(() =>
    document.querySelector("#entry-error").textContent.includes("진행 중"),
  );
  const art = [];
  for (const r of rooms) {
    art.push(await page.locator("#room-art").getAttribute("src"));
    if (r.room.type === "single")
      await page.locator(`#puzzle-content [data-value="${r.answer}"]`).click();
    else await page.locator("#answer").fill(r.answer);
    await page.locator("#answer-form").evaluate((f) => f.requestSubmit());
    await page.locator("#next").waitFor({ state: "visible" });
    assert.equal(attempts.get("00123").nextStage, r.stage + 1);
    await page.locator("#next").click();
  }
  await page.locator("#success").waitFor({ state: "visible" });
  assert.equal(entries.length, 1);
  assert.equal(new Set(art).size, 4);
  await enter(otherPage, "00123", publicName);
  await otherPage.waitForFunction(() =>
    document.querySelector("#entry-error").textContent.includes("완료"),
  );
  await page.reload();
  await enter(page, "00123", publicName);
  await page.locator("#success").waitFor({ state: "visible" });
  assert.equal(entries.length, 1);
  assert.equal(await page.locator("#restart").count(), 0);
  await page.locator("#ranking").click();
  await page.waitForFunction(
    () =>
      document.querySelectorAll("#ranking-body tr").length === 1 &&
      !!window.rankEvent,
  );
  assert.equal(
    await page.locator("#ranking-body tr td").nth(1).textContent(),
    "00123",
  );
  assert.equal(
    await page.locator("#ranking-body tr td").nth(2).textContent(),
    publicName,
  );
  assert.equal(await page.locator("#ranking-body img").count(), 0);
  entries.push({
    id: "2",
    studentId: "99999",
    name: "이학생",
    elapsedMs: 180000,
    hintsUsed: 0,
    completedAt: "2026-10-01T00:03:00Z",
  });
  await page.evaluate(() => window.rankEvent());
  await page.waitForFunction(
    () => document.querySelectorAll("#ranking-body tr").length === 2,
  );
  await page.locator("#ranking-dialog [data-close]").click();
  await page.waitForFunction(() => window.removedChannels === 1);
  assert.equal(await page.evaluate(() => window.removedChannels), 1);
  for (const width of [360, 390, 768, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
      `overflow at ${width}`,
    );
  }
  assert.deepEqual(errors, []);
  await other.close();
  await context.close();
});

test("unconfigured deployment prevents entry", async (t) => {
  const browser = await chromium.launch({
    channel: process.env.PLAYWRIGHT_CHANNEL || "chrome",
    headless: true,
  });
  t.after(() => browser.close());
  const page = await browser.newPage();
  await page.route("http://localhost:54399/", (r) =>
    r.fulfill({
      contentType: "text/html",
      body: fs.readFileSync(path.join(root, "index.html"), "utf8"),
    }),
  );
  await page.route("**/game-config.js", (r) =>
    r.fulfill({
      contentType: "text/javascript",
      body: 'window.GAME_CONFIG={supabaseUrl:"",publishableKey:""};',
    }),
  );
  await page.goto("http://localhost:54399/");
  assert.equal(await page.locator("#start").isDisabled(), true);
  assert.match(await page.locator("#entry-error").textContent(), /입장 준비/);
});
