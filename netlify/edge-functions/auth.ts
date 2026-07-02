/* 整站帳密保護（Basic Auth）
   帳密由 Netlify 環境變數提供：SITE_AUTH_USER / SITE_AUTH_PASS。
   SITE_AUTH_PASS 未設定時不啟用驗證（避免誤鎖整個站台），
   因此正式啟用前務必先在 Netlify 設定該環境變數。 */
import type { Context, Config } from "@netlify/edge-functions";

declare const Netlify: { env: { get(name: string): string | undefined } };

export default async (req: Request, context: Context) => {
  const user = Netlify.env.get("SITE_AUTH_USER") || "kg";
  const pass = Netlify.env.get("SITE_AUTH_PASS") || "";
  if (!pass) return context.next();

  const auth = req.headers.get("authorization") || "";
  const expected = "Basic " + btoa(`${user}:${pass}`);
  if (auth === expected) return context.next();

  return new Response("需要登入 / Authentication required", {
    status: 401,
    headers: {
      "WWW-Authenticate": 'Basic realm="KG Manpower", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8"
    }
  });
};

export const config: Config = { path: "/*" };
