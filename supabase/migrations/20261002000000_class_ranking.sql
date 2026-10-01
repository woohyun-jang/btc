-- Filter before limiting so each class has its own top 100.
create function public.game_ranking(p_class_prefix text default null)
returns jsonb
language plpgsql
set search_path = public, pg_temp
as $function$
begin
  if p_class_prefix is not null and p_class_prefix !~ '^[0-9]{3}$' then
    raise exception using errcode = 'P0001', message = 'INVALID_REQUEST';
  end if;
  return jsonb_build_object(
    'classes', coalesce((select jsonb_agg(class_prefix order by class_prefix)
      from (select distinct left(student_id, 3) as class_prefix from public.game_leaderboard) classes), '[]'::jsonb),
    'entries', coalesce((select jsonb_agg(jsonb_build_object(
      'id', id, 'studentId', student_id, 'name', name, 'elapsedMs', elapsed_ms,
      'hintsUsed', hints_used, 'completedAt', completed_at) order by elapsed_ms, completed_at, id)
      from (select * from public.game_leaderboard
        where p_class_prefix is null or left(student_id, 3) = p_class_prefix
        order by elapsed_ms, completed_at, id limit 100) entries), '[]'::jsonb)
  );
end;
$function$;
revoke all on function public.game_ranking(text) from public, anon, authenticated;
grant execute on function public.game_ranking(text) to service_role;
