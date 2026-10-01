import { createClient } from "npm:@supabase/supabase-js@2.58.0";
import { createGameHandler } from "./handler.ts";

const database = createClient(
  Deno.env.get("SUPABASE_URL")!,
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,
  { auth: { persistSession: false, autoRefreshToken: false } },
);

Deno.serve(createGameHandler(database, Deno.env.get("ALLOWED_ORIGIN") ?? "https://woohyun-jang.github.io"));
