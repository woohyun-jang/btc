type GameDatabase = {
  rpc: (name: string, args: Record<string, unknown>) => PromiseLike<{
    data: unknown;
    error: { code?: string; message?: string } | null;
  }>;
};

const errors: Record<string, { status: number; message: string }> = {
  INVALID_REQUEST: { status: 400, message: "입력한 내용을 확인해주세요." },
  TOKEN_IN_USE: { status: 409, message: "새 세션으로 다시 입장해주세요." },
  IN_PROGRESS: { status: 409, message: "이미 진행 중인 학번입니다. 처음 시작한 기기에서 이어주세요." },
  COMPLETED: { status: 409, message: "이미 완료한 학번입니다. 다시 도전할 수 없습니다." },
  SESSION_NOT_FOUND: { status: 401, message: "참가 정보를 찾을 수 없습니다. 입장 정보를 확인해주세요." },
  STAGE_MISMATCH: { status: 409, message: "진행 상태가 바뀌었습니다. 현재 상태를 다시 확인해주세요." },
  ORIGIN_NOT_ALLOWED: { status: 403, message: "허용되지 않은 요청입니다." },
  METHOD_NOT_ALLOWED: { status: 405, message: "지원하지 않는 요청입니다." },
  SERVER_ERROR: { status: 500, message: "서버 요청을 처리하지 못했습니다. 잠시 후 다시 시도해주세요." },
};

export function createGameHandler(database: GameDatabase, allowedOrigin: string) {
  return async (request: Request): Promise<Response> => {
    const headers = new Headers({
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "Vary": "Origin",
      "Access-Control-Allow-Methods": "POST, OPTIONS",
      "Access-Control-Allow-Headers": "content-type, apikey, authorization, x-client-info",
    });
    const origin = request.headers.get("Origin");
    if (origin === allowedOrigin) headers.set("Access-Control-Allow-Origin", allowedOrigin);
    const failure = (code: string) => {
      const error = errors[code] ?? errors.SERVER_ERROR;
      return new Response(JSON.stringify({ error: { code: errors[code] ? code : "SERVER_ERROR", message: error.message } }), { status: error.status, headers });
    };
    if (origin && origin !== allowedOrigin) return failure("ORIGIN_NOT_ALLOWED");
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers });
    if (request.method !== "POST") return failure("METHOD_NOT_ALLOWED");

    try {
      const text = await request.text();
      if (text.length > 4096) return failure("INVALID_REQUEST");
      const body = JSON.parse(text);
      if (!body || typeof body !== "object" || Array.isArray(body)) return failure("INVALID_REQUEST");
      const { action, sessionToken, studentId, name, stage, answer, classPrefix } = body;
      if (!["enter", "state", "answer", "hint", "ranking"].includes(action)) return failure("INVALID_REQUEST");
      if (action === "ranking") {
        if (classPrefix != null && (typeof classPrefix !== "string" || !/^[0-9]{3}$/.test(classPrefix))) return failure("INVALID_REQUEST");
        const { data, error } = await database.rpc("game_ranking", { p_class_prefix: classPrefix ?? null });
        if (error) return failure(error.code === "P0001" && error.message ? error.message : "SERVER_ERROR");
        return new Response(JSON.stringify(data), { status: 200, headers });
      }
      let tokenHash: string | null = null;
      if (action !== "ranking") {
        if (typeof sessionToken !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(sessionToken)) return failure("INVALID_REQUEST");
        const bytes = Uint8Array.from(atob(sessionToken.replaceAll("-", "+").replaceAll("_", "/") + "="), (character) => character.charCodeAt(0));
        const canonical = btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
        if (bytes.length !== 32 || canonical !== sessionToken) return failure("INVALID_REQUEST");
        const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(sessionToken));
        tokenHash = Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
      }
      if (action === "enter" && (typeof studentId !== "string" || !/^[0-9]{5}$/.test(studentId) || typeof name !== "string" || Array.from(name.trim()).length < 1 || Array.from(name.trim()).length > 40)) return failure("INVALID_REQUEST");
      if ((action === "answer" || action === "hint") && (!Number.isInteger(stage) || stage < 0 || stage > 9)) return failure("INVALID_REQUEST");
      if (action === "answer" && (typeof answer !== "string" || Array.from(answer).length > 200)) return failure("INVALID_REQUEST");
      const { data, error } = await database.rpc("game_request", {
        p_action: action,
        p_token_hash: tokenHash,
        p_student_id: action === "enter" ? studentId : null,
        p_name: action === "enter" ? name.trim() : null,
        p_stage: action === "answer" || action === "hint" ? stage : null,
        p_answer: action === "answer" ? answer : null,
      });
      if (error) return failure(error.code === "P0001" && error.message ? error.message : "SERVER_ERROR");
      return new Response(JSON.stringify(data), { status: 200, headers });
    } catch (error) {
      return failure(error instanceof SyntaxError ? "INVALID_REQUEST" : "SERVER_ERROR");
    }
  };
}
