# Supabase 운영 설정

학번당 한 번만 참가할 수 있습니다. 같은 브라우저에 저장한 세션으로 진행 중인 게임을 이어갈 수 있으며 완료 후에는 새 도전을 시작할 수 없습니다. 완료된 참가자의 학번, 이름, 소요 시간, 힌트 수는 공개 순위에 표시됩니다.

## 현재 운영 환경

- 사이트: https://woohyun-jang.github.io/btc/
- Supabase: https://supabase.com/dashboard/project/nwrhazumfqfioicaykqp
- 리전: 서울 (`ap-northeast-2`)
- DB 비밀번호는 macOS 키체인의 `Supabase CLI` 서비스, 프로젝트 ID 계정에 저장합니다.

## 배포

Supabase 프로젝트를 만든 뒤 `npx supabase login`으로 이 컴퓨터의 CLI에 로그인합니다. 비밀번호와 secret/service_role 키를 채팅이나 저장소에 넣지 않습니다. 아래 명령의 `supabase`는 CLI 미설치 시 `npx supabase`로 실행할 수 있습니다.

```sh
supabase link --project-ref YOUR_PROJECT_REF
supabase db push
supabase secrets set ALLOWED_ORIGIN=https://woohyun-jang.github.io
supabase functions deploy game
```

`supabase/config.toml`은 `game` 함수의 JWT 검증을 끕니다. 쓰기 권한은 참가 시 만든 세션 토큰으로 검증합니다. Supabase가 함수에 제공하는 `SUPABASE_URL`과 `SUPABASE_SERVICE_ROLE_KEY`를 사용하며 서비스 키를 브라우저에 넣지 않습니다.

`game-config.js`의 `supabaseUrl`에는 프로젝트 URL을, `publishableKey`에는 공개용 publishable key를 입력합니다. CORS 허용 주소에는 `/btc` 경로를 포함하지 않습니다. 로컬 프런트를 연결할 때는 `ALLOWED_ORIGIN`을 해당 서버의 origin으로 변경합니다.

## API

`POST {supabaseUrl}/functions/v1/game`에 JSON을 보내며, 모든 응답에 `Cache-Control: no-store`가 적용됩니다. 클라이언트는 참가 요청 전에 무작위 32바이트를 base64url로 인코딩한 43글자 `sessionToken`을 저장합니다. 재시도에 같은 토큰을 사용해야 하며 서버에는 SHA-256 해시만 저장됩니다.

| action  | 요청 필드                     | 성공 응답        |
| ------- | ----------------------------- | ---------------- |
| enter   | studentId, name, sessionToken | {state}          |
| state   | sessionToken                  | {state}          |
| answer  | sessionToken, stage, answer   | {correct, state} |
| hint    | sessionToken, stage           | {hint, state}    |
| ranking | 없음                          | {entries}        |

`stage`는 0부터 9까지입니다. 학번은 숫자 5자리 문자열이며 이름은 양끝 공백 제거 후 1~40글자입니다. `state`는 `studentId`, `name`, `startedAt`, `serverNow`, `completedAt`, `elapsedMs`, `nextStage`, `hints`, `recaps`, `room`을 포함합니다. 현재 문제의 `room`에는 정답·해설·힌트가 없으며, 해결한 문제의 `recaps`에만 정답과 해설이 제공됩니다. 힌트 본문은 `hint` 요청에만 제공됩니다. 완료 후 `room`은 null이며 최종 소요 시간과 힌트 수는 고정됩니다.

정답 재시도는 이미 해결한 단계에서 올바른 답일 때만 성공합니다. 힌트 재시도는 같은 단계의 힌트 수를 늘리지 않습니다. 완료 후에는 이미 기록된 힌트만 다시 조회할 수 있습니다.

`entries`는 `{id, studentId, name, elapsedMs, hintsUsed, completedAt}`이며 소요 시간, 완료 시각, 무작위 ID 순으로 상위 100명을 반환합니다. 시각과 소요 시간은 PostgreSQL에서 계산합니다. 마지막 정답 처리와 공개 순위 등록은 한 트랜잭션에서 실행됩니다.

오류는 `{error: {code, message}}`입니다. 입력 오류는 `INVALID_REQUEST` 400, 없는 세션은 `SESSION_NOT_FOUND` 401, 다른 기기의 진행 중 학번은 `IN_PROGRESS` 409, 완료 학번은 `COMPLETED` 409, 단계 불일치는 `STAGE_MISMATCH` 409입니다. 내부 데이터베이스 오류는 세부 내용 없이 `SERVER_ERROR` 500으로 반환합니다.

## 데이터 접근과 실시간 순위

`public.game_attempts`와 `public.game_rooms`에는 RLS가 적용되며 공개 키로 읽거나 쓸 수 없습니다. RPC `game_request`와 `game_state`는 service_role만 실행할 수 있습니다. 공개 테이블 `public.game_leaderboard`에는 `id`, `student_id`, `name`, `elapsed_ms`, `hints_used`, `completed_at`만 저장되며 anon/authenticated는 읽기만 허용됩니다.

Realtime에서는 `public.game_leaderboard`의 `INSERT` 이벤트를 구독한 뒤 `ranking` API를 다시 조회합니다. 참가 세션 테이블은 Realtime publication에 포함하지 않습니다.

## 로컬 검증

Node.js 22.15 이상과 Docker가 필요합니다. 브라우저 검증은 API와 Realtime SDK를 모의 연결한 Chrome으로 진행합니다.

```sh
npm ci
npm run test:frontend
```

Chrome이 없는 환경에서는 `npx playwright install chromium` 후 `PLAYWRIGHT_CHANNEL=chromium npm run test:frontend`로 실행합니다. 첫 실행 전에 PostgreSQL 이미지를 준비합니다.

```sh
docker pull postgres:17-alpine
node --experimental-strip-types --test tests/backend.test.mjs
npx --yes --package=deno@2.5.6 deno check --no-lock --node-modules-dir=none supabase/functions/game/index.ts
npx --yes --package=deno@2.5.6 deno lint --rules-exclude=no-import-prefix supabase/functions/game
```

테스트는 네트워크가 차단된 임시 PostgreSQL 17 컨테이너에서 migration, 동시 입장·정답·힌트 처리, 완료 재도전 차단, 공개 순위, 공개 역할의 접근 제한, HTTP 입력 검증과 CORS를 확인합니다. 종료 시 테스트 컨테이너를 제거합니다. 2026-10-01 운영 환경에서 실제 Edge Function을 통한 10단계 완료, 별도 브라우저의 완료 학번 재도전 차단, Realtime INSERT 이벤트에 따른 랭킹 자동 갱신을 확인했습니다. 검증 참가 기록은 삭제했습니다.
