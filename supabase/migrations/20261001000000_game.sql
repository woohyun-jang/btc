create table public.game_rooms (
  stage integer primary key check (stage between 0 and 9),
  presentation jsonb not null,
  answer text not null,
  hint text not null,
  explanation text not null
);

create table public.game_attempts (
  student_id text primary key check (student_id ~ '^[0-9]{5}$'),
  name text not null check (char_length(name) between 1 and 40 and name = btrim(name)),
  token_hash text not null unique check (token_hash ~ '^[0-9a-f]{64}$'),
  started_at timestamptz not null default clock_timestamp(),
  completed_at timestamptz,
  next_stage integer not null default 0 check (next_stage between 0 and 10),
  hints integer[] not null default '{}',
  check ((next_stage = 10) = (completed_at is not null)),
  check (completed_at is null or completed_at >= started_at)
);

create table public.game_leaderboard (
  id uuid primary key default gen_random_uuid(),
  student_id text not null,
  name text not null,
  elapsed_ms bigint not null check (elapsed_ms >= 0),
  hints_used integer not null check (hints_used between 0 and 10),
  completed_at timestamptz not null
);

create index game_leaderboard_order on public.game_leaderboard (elapsed_ms, completed_at, id);

alter table public.game_rooms enable row level security;
alter table public.game_attempts enable row level security;
alter table public.game_leaderboard enable row level security;
revoke all on public.game_rooms, public.game_attempts, public.game_leaderboard from anon, authenticated;
grant all on public.game_rooms, public.game_attempts, public.game_leaderboard to service_role;
grant select on public.game_leaderboard to anon, authenticated;
create policy game_leaderboard_read on public.game_leaderboard for select to anon, authenticated using (true);

create function public.game_state(p_attempt public.game_attempts)
returns jsonb
language sql
volatile
set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'studentId', p_attempt.student_id,
    'name', p_attempt.name,
    'startedAt', p_attempt.started_at,
    'serverNow', clock_timestamp(),
    'completedAt', p_attempt.completed_at,
    'elapsedMs', greatest(0, floor(extract(epoch from (coalesce(p_attempt.completed_at, clock_timestamp()) - p_attempt.started_at)) * 1000))::bigint,
    'nextStage', p_attempt.next_stage,
    'hints', to_jsonb(p_attempt.hints),
    'recaps', coalesce((select jsonb_agg(jsonb_build_object('stage', stage, 'answer', answer, 'explanation', explanation) order by stage) from public.game_rooms where stage < p_attempt.next_stage), '[]'::jsonb),
    'room', (select presentation from public.game_rooms where stage = p_attempt.next_stage)
  );
$function$;

create function public.game_request(
  p_action text,
  p_token_hash text default null,
  p_student_id text default null,
  p_name text default null,
  p_stage integer default null,
  p_answer text default null
)
returns jsonb
language plpgsql
volatile
set search_path = public, pg_temp
as $function$
declare
  v_attempt public.game_attempts;
  v_room public.game_rooms;
  v_correct boolean;
begin
  if p_action = 'ranking' then
    return jsonb_build_object('entries', coalesce((
      select jsonb_agg(jsonb_build_object('id', id, 'studentId', student_id, 'name', name, 'elapsedMs', elapsed_ms, 'hintsUsed', hints_used, 'completedAt', completed_at) order by elapsed_ms, completed_at, id)
      from (select * from public.game_leaderboard order by elapsed_ms, completed_at, id limit 100) entries
    ), '[]'::jsonb));
  end if;

  if p_action is null or p_action not in ('enter', 'state', 'answer', 'hint') or p_token_hash is null or p_token_hash !~ '^[0-9a-f]{64}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_REQUEST';
  end if;

  if p_action = 'enter' then
    if p_student_id is null or p_student_id !~ '^[0-9]{5}$' or p_name is null or char_length(btrim(p_name)) not between 1 and 40 then
      raise exception using errcode = 'P0001', message = 'INVALID_REQUEST';
    end if;
    insert into public.game_attempts (student_id, name, token_hash)
      values (p_student_id, btrim(p_name), p_token_hash) on conflict do nothing;
    select * into v_attempt from public.game_attempts where student_id = p_student_id for update;
    if not found then
      raise exception using errcode = 'P0001', message = 'TOKEN_IN_USE';
    end if;
    if v_attempt.token_hash <> p_token_hash then
      raise exception using errcode = 'P0001', message = case when v_attempt.completed_at is null then 'IN_PROGRESS' else 'COMPLETED' end;
    end if;
    return jsonb_build_object('state', public.game_state(v_attempt));
  end if;

  select * into v_attempt from public.game_attempts where token_hash = p_token_hash for update;
  if not found then
    raise exception using errcode = 'P0001', message = 'SESSION_NOT_FOUND';
  end if;
  if p_action = 'state' then
    return jsonb_build_object('state', public.game_state(v_attempt));
  end if;
  if p_stage is null or p_stage not between 0 and 9 then
    raise exception using errcode = 'P0001', message = 'INVALID_REQUEST';
  end if;
  if p_stage > v_attempt.next_stage then
    raise exception using errcode = 'P0001', message = 'STAGE_MISMATCH';
  end if;
  select * into v_room from public.game_rooms where stage = p_stage;

  if p_action = 'hint' then
    if not (p_stage = any(v_attempt.hints)) then
      if v_attempt.completed_at is not null then
        raise exception using errcode = 'P0001', message = 'COMPLETED';
      end if;
      update public.game_attempts set hints = array_append(hints, p_stage) where student_id = v_attempt.student_id returning * into v_attempt;
    end if;
    return jsonb_build_object('hint', v_room.hint, 'state', public.game_state(v_attempt));
  end if;

  if p_answer is null or char_length(p_answer) > 200 then
    raise exception using errcode = 'P0001', message = 'INVALID_REQUEST';
  end if;
  v_correct := regexp_replace(normalize(p_answer, NFC), '[[:space:],，·ㆍ-]', '', 'g') = v_room.answer;
  if p_stage < v_attempt.next_stage then
    if not v_correct then
      raise exception using errcode = 'P0001', message = 'STAGE_MISMATCH';
    end if;
    return jsonb_build_object('correct', true, 'state', public.game_state(v_attempt));
  end if;
  if v_correct then
    update public.game_attempts
      set next_stage = next_stage + 1, completed_at = case when next_stage = 9 then clock_timestamp() else null end
      where student_id = v_attempt.student_id returning * into v_attempt;
    if v_attempt.completed_at is not null then
      insert into public.game_leaderboard (student_id, name, elapsed_ms, hints_used, completed_at)
        values (v_attempt.student_id, v_attempt.name,
          floor(extract(epoch from (v_attempt.completed_at - v_attempt.started_at)) * 1000)::bigint,
          cardinality(v_attempt.hints), v_attempt.completed_at);
    end if;
  end if;
  return jsonb_build_object('correct', v_correct, 'state', public.game_state(v_attempt));
end;
$function$;

revoke all on function public.game_state(public.game_attempts) from public, anon, authenticated;
revoke all on function public.game_request(text, text, text, text, integer, text) from public, anon, authenticated;
grant execute on function public.game_state(public.game_attempts) to service_role;
grant execute on function public.game_request(text, text, text, text, integer, text) to service_role;

alter publication supabase_realtime add table public.game_leaderboard;

insert into public.game_rooms (stage, presentation, answer, hint, explanation) values
(0, '{"name":"시간 관리","topic":"TIME MANAGEMENT","title":"비효율적인 시간 관리의 방","story":"퇴근 시간이 다 되었지만, 오늘 해야 할 일들이 뒤죽박죽 섞여 있습니다. 업무의 우선순위를 바로잡아 잠긴 사무실 문을 여세요.","mission":"업무를 순서대로 정리하고 암호를 완성하세요.","missionSub":"중요도와 긴급도가 첫 번째 열쇠입니다.","questionTitle":"무엇부터 처리해야 할까요?","question":"‘중요하고 긴급한 일’부터 ‘중요하지 않고 긴급하지 않은 일’까지, 기호를 순서대로 배열하세요.","type":"order","options":[["가","SNS 피드 확인 및 연예 뉴스 읽기"],["나","오늘 5시까지 제출해야 하는 중요 프로젝트 보고서 작성"],["다","내일 진행될 회의 자료 미리 읽어보기"],["라","갑자기 걸려온 친구의 잡담 전화"]],"placeholder":"기호 4개를 순서대로 입력"}'::jsonb, '나다라가', '당장 반응하게 만드는 일과, 미루었을 때 손실이 커지는 일은 같을까요? 두 기준을 따로 비교해보세요.', '보고서(나)는 중요하고 긴급한 일, 회의 준비(다)는 중요하지만 덜 긴급한 일입니다. 잡담 전화(라)는 급하게 응답해야 하지만 덜 중요한 일, SNS(가)는 중요도와 긴급도가 모두 낮은 일입니다.'),
(1, '{"name":"일·가정 양립","topic":"WORK–LIFE BALANCE","title":"잘못된 일·가정 양립 상식의 방","story":"두 번째 문에는 복잡한 도어락이 있습니다. 일·가정 양립 제도에 대한 잘못된 상식을 걷어내고, 올바른 설명으로 암호를 만드세요.","mission":"올바른 설명 두 개를 찾아 도어락을 여세요.","missionSub":"선택한 번호가 작은 번호부터 암호로 조합됩니다.","questionTitle":"일과 돌봄을 함께하려면?","question":"올바른 진술의 번호를 순서대로 조합한 2자리 숫자를 입력하세요.","type":"multi","options":[["1","육아휴직은 어머니만 신청할 수 있고, 아버지는 신청할 수 없다."],["2","‘육아기 근로시간 단축제’를 활용하면 일하는 시간을 줄여 육아와 일을 병행할 수 있다."],["3","‘유연근무제’는 출퇴근 시간을 조정하거나 재택근무를 활용해 시간을 효율적으로 쓰는 제도이다."],["4","가사 노동은 돈을 벌지 않으므로 경제적 가치가 전혀 없다."]],"placeholder":"올바른 번호 2개 입력"}'::jsonb, '23', '진술 속에 예외를 모두 지워버리는 표현이 있는지 살펴보세요. 제도의 목적과 이용 범위도 구분해보세요.', '올바른 진술은 2번과 3번입니다. 육아기 근로시간 단축과 유연근무는 일과 돌봄을 함께하는 데 도움이 됩니다. 육아휴직은 아버지도 신청할 수 있으며, 가사 노동에는 경제적 가치가 있습니다.'),
(2, '{"name":"공평한 분담","topic":"SHARED RESPONSIBILITY","title":"가사 노동 분담 불균형의 방","story":"퇴근 후 집에 도착했지만, 집안일이 한 사람에게 몰려 갈등이 폭발하기 직전입니다. 공평한 역할 분담을 찾아 가족의 저녁을 구하세요.","mission":"공평한 분담을 방해하는 설명을 찾아보세요.","missionSub":"이번에는 가장 적절하지 않은 문장입니다.","questionTitle":"함께 사는 집, 함께 나누는 일.","question":"가사 노동과 역할 분담에 대한 설명으로 가장 적절하지 않은 것의 번호를 선택하세요.","type":"single","options":[["1","가사 노동에는 요리, 청소뿐 아니라 가족 구성원을 케어하는 ‘돌봄 노동’도 포함된다."],["2","가사 노동의 가치를 시장 가격(최저시급 등)으로 환산하면 월 수백만 원 상당의 높은 경제적 가치를 지닌다."],["3","성별 역할 고정관념에서 벗어나 각자의 능력과 시간에 맞춰 공평하게 분담해야 한다."],["4","집안일은 시간이 남는 사람이 전담하는 것이 가장 효율적인 일·가정 양립 방법이다."]],"placeholder":"보기에서 번호를 선택하세요"}'::jsonb, '4', '겉으로 보이는 여유 시간만으로 실제 부담까지 알 수 있을까요? 문장마다 판단의 기준을 찾아보세요.', '가장 적절하지 않은 설명은 4번입니다. 시간이 남는다는 이유로 한 사람에게 집안일을 모두 맡기면 부담이 쏠립니다. 각자의 시간과 능력, 돌봄 부담을 함께 고려해 공평하게 분담해야 합니다.'),
(3, '{"name":"갈등 소통","topic":"I-MESSAGE","title":"갈등 소통의 방","story":"지친 상태에서 집안일 분담 문제로 말다툼이 시작되었습니다. 비난 대신 내 마음을 전달하는 ‘나-대화법’으로 다음 탈출 키를 얻으세요.","mission":"상대방을 비난하지 않고 나의 마음을 전달하세요.","missionSub":"두 단어를 (A), (B) 순서대로 선택하세요.","questionTitle":"비난 대신, 내 마음을 말해요.","question":"‘나-대화법(I-Message)’ 문장의 빈칸 (A), (B)에 들어갈 단어를 순서대로 선택하거나 입력하세요.","type":"words","options":[["행동","행동"],["감정","감정"],["평가","평가"],["성격","성격"]],"placeholder":"(A), (B) 단어를 순서대로 입력"}'::jsonb, '행동감정', '같은 장면을 두 사람이 서로 다르게 받아들일 수 있어요. 문장에서 누가 무엇을 설명하는지 나누어 생각해보세요.', '(A)는 행동, (B)는 감정입니다. 예를 들어 “설거지가 그대로 남아 있을 때, 나는 혼자 집안일을 맡는 것 같아 지쳐. 함께 나눠 하면 좋겠어.”처럼 행동과 내 감정을 연결해서 말해보세요.'),
(4, '{"name":"업무 조율","topic":"WORKLOAD NEGOTIATION","title":"퇴근 직전 업무 조율의 방","story":"퇴근 직전 새 업무가 도착했습니다. 오늘 마감인 기존 업무와 새 요청을 모두 끝내기에는 시간이 부족합니다. 현실적인 업무 조율로 야근의 고리를 끊으세요.","mission":"무조건 수락하거나 거절하기 전에 상황을 판단하세요.","missionSub":"가장 적절한 대응 한 가지를 선택하세요.","questionTitle":"일이 한꺼번에 몰렸다면?","question":"새 업무의 마감과 중요도가 아직 확인되지 않았습니다. 기존 업무도 오늘 마감입니다. 가장 적절한 첫 대응은 무엇일까요?","type":"single","options":[["1","새 업무부터 시작하고 기존 업무의 지연은 마감 이후에 알린다."],["2","새 업무의 마감·중요도를 확인하고, 기존 업무와의 우선순위 및 기한을 요청자와 조율한다."],["3","퇴근 직전의 요청은 내용과 무관하게 모두 거절한다."],["4","두 업무를 모두 수락하고 아무에게도 알리지 않은 채 밤새 처리한다."]],"placeholder":"보기에서 번호를 선택하세요"}'::jsonb, '2', '결정에 필요한 정보가 충분한지부터 점검해보세요. 선택의 결과를 누가 함께 알아야 할지도 생각해보세요.', '2번입니다. 마감과 중요도를 확인한 뒤 현재 업무량을 공유하고 우선순위나 기한을 조율해야 합니다. 말없이 지연시키거나 모든 요청을 일괄적으로 수락·거절하면 상황에 맞는 판단을 하기 어렵습니다.'),
(5, '{"name":"회복 시간","topic":"TIME TO RECOVER","title":"사라진 휴식 시간의 방","story":"집안일을 끝낸 뒤 함께 쉴 시간을 확보하려 합니다. 두 사람이 동시에 할 수 있는 일과 순서가 필요한 일을 구분하면 숨겨진 시간이 드러납니다.","mission":"저녁 일정을 계산해 함께 쉴 시간을 찾으세요.","missionSub":"두 사람은 18:00에 시작하며, 일 사이 이동 시간은 없습니다.","questionTitle":"우리의 휴식은 언제 시작될까요?","question":"저녁 준비 30분 → 함께 식사 20분 → 함께 식탁 정리 10분은 순서대로 진행합니다. 빨래 정리 20분은 한 사람이 저녁을 준비하는 동안 다른 사람이 할 수 있습니다. 모든 일을 마친 뒤 함께 쉬기 시작할 수 있는 가장 빠른 시각은?","type":"single","options":[["1","18:40"],["2","18:50"],["3","19:00"],["4","19:20"]],"placeholder":"보기에서 번호를 선택하세요"}'::jsonb, '3', '총 소요 시간을 단순히 더하기 전에, 어떤 일이 다른 일의 종료를 기다려야 하는지 표시해보세요.', '3번, 19:00입니다. 18:00~18:30 저녁 준비 중 빨래 정리도 끝낼 수 있습니다. 이어서 18:30~18:50 함께 식사하고, 18:50~19:00 식탁을 정리하면 함께 쉴 수 있습니다.'),
(6, '{"name":"보이지 않는 일","topic":"INVISIBLE CARE","title":"보이지 않는 돌봄 노동의 방","story":"가사 분담표에는 청소와 설거지만 적혀 있습니다. 하지만 가족 일정과 필요한 물품을 챙기는 일은 여전히 한 사람의 머릿속에만 남아 있습니다.","mission":"분담표에 빠진 역할까지 찾아보세요.","missionSub":"적절한 설명 두 개의 번호를 작은 번호부터 입력하세요.","questionTitle":"손을 움직이는 일만 집안일일까요?","question":"가족의 생활을 미리 챙기고 조율하는 부담에 대한 설명 중 적절한 것 두 개를 선택하세요.","type":"multi","options":[["1","가족의 병원 예약과 준비물을 기억하고 챙기는 일도 분담할 수 있는 역할이다."],["2","실제 청소 시간을 똑같이 나누었다면 다른 부담은 고려할 필요가 없다."],["3","일을 수행하는 사람뿐 아니라 필요를 파악하고 계획하는 사람의 부담도 확인해야 한다."],["4","한 사람이 모든 일을 기억하고 다른 사람에게 매번 지시하면 역할 분담이 완성된다."]],"placeholder":"올바른 번호 2개 입력"}'::jsonb, '13', '분담표에 적힌 일의 앞뒤를 떠올려보세요. 누군가는 일을 시작하기 전에도 무언가를 하고 있을 수 있어요.', '1번과 3번입니다. 예약, 준비물 확인, 일정 기억, 계획과 조율에도 시간과 주의가 필요합니다. 눈에 보이는 작업 시간만 나누면 이 부담은 한 사람에게 남을 수 있습니다.'),
(7, '{"name":"노동의 가치","topic":"VALUE OF HOUSEWORK","title":"가사 노동 가치의 방","story":"가사 노동의 가치가 적힌 장부가 잠겼습니다. 직접 돈을 받지 않는 일도 다른 사람에게 맡기려면 비용이 듭니다. 아래의 가정으로 장부를 복원하세요.","mission":"제시된 조건으로 한 달의 가치를 계산하세요.","missionSub":"실제 통계가 아닌, 게임에서 정한 계산 조건입니다.","questionTitle":"돈을 받지 않아도 가치가 있어요.","question":"가사 노동을 하루 2시간, 한 달 30일 수행했습니다. 같은 일을 맡기는 비용을 시간당 15,000원으로 가정하면 한 달의 가치는 얼마일까요? 원 단위 숫자만 입력하세요.","type":"number","options":[],"placeholder":"원 단위 숫자 입력"}'::jsonb, '900000', '시간당 금액에 곱할 시간의 단위를 먼저 맞춰보세요. 질문은 하루의 가치가 아니라 한 달의 가치를 묻고 있어요.', '2시간 × 30일 × 15,000원 = 900,000원입니다. 이는 문제에서 정한 가정에 따른 계산이며, 실제 가치는 노동의 종류와 시간, 계산 기준에 따라 달라집니다.'),
(8, '{"name":"경청","topic":"ACTIVE LISTENING","title":"닫힌 마음을 여는 방","story":"상대방이 “요즘 집안일 때문에 너무 지쳐”라고 말합니다. 바로 해답을 내놓기보다 상대의 이야기를 이해하는 반응으로 닫힌 마음을 열어보세요.","mission":"대화를 이어갈 수 있는 첫 반응을 선택하세요.","missionSub":"상대방의 표현을 이해하는 데 초점을 맞추세요.","questionTitle":"상대방의 말을 들은 다음에는?","question":"“요즘 집안일 때문에 너무 지쳐”라는 말에 가장 적절한 첫 반응은 무엇일까요?","type":"single","options":[["1","나도 힘든데, 네가 참으면 될 것 같아."],["2","집안일 때문에 많이 지쳤구나. 어떤 일이 특히 부담되는지 이야기해줄래?"],["3","그럼 앞으로 집안일은 하지 마. 다른 이야기는 그만하자."],["4","그 정도로 힘들 리 없잖아. 내가 더 바빠."]],"placeholder":"보기에서 번호를 선택하세요"}'::jsonb, '2', '내가 하고 싶은 말을 먼저 떠올리기보다, 상대가 지금 말하고 싶은 것이 무엇인지 생각해보세요.', '2번입니다. 상대가 표현한 마음을 인정하고 구체적인 부담을 물으면 대화를 이어갈 수 있습니다. 곧바로 비교하거나 평가하고 대화를 끝내는 반응은 서로의 상황을 이해하기 어렵게 만듭니다.'),
(9, '{"name":"저녁의 약속","topic":"OUR EVENING PLAN","title":"함께 만드는 저녁의 방","story":"마지막 문 너머에는 가족의 저녁이 기다리고 있습니다. 이번 주의 일정과 집안일을 함께 조율하고, 실행 뒤에도 조정할 수 있는 계획을 완성하세요.","mission":"함께 정한 계획을 지속하는 순서를 완성하세요.","missionSub":"아직 일정을 서로 모르는 상태에서 시작합니다.","questionTitle":"지속할 수 있는 약속을 만들어요.","question":"가족의 일정을 함께 조율하는 네 과정을 올바른 순서로 배열하세요. 현재 서로의 일정과 부담은 아직 공유하지 않았습니다.","type":"order","options":[["가","합의한 역할 분담과 일정을 실제로 실행한다."],["나","실행 후 부담과 어려움을 돌아보고 다음 계획을 조정한다."],["다","각자의 이번 주 일정과 돌봄·집안일 부담을 공유한다."],["라","공유한 상황을 바탕으로 역할과 시간을 함께 합의한다."]],"placeholder":"기호 4개를 순서대로 입력"}'::jsonb, '다라가나', '뒤의 과정이 앞의 어떤 정보를 필요로 하는지 연결해보세요. 계획은 한 번 정하고 끝나는 것일까요?', '상황 공유(다) → 함께 합의(라) → 실행(가) → 점검과 조정(나) 순서입니다. 각자의 상황을 먼저 알고 계획을 정한 뒤, 실제 부담을 돌아보며 수정하면 함께 지킬 수 있는 약속이 됩니다.');
