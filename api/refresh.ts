import { refreshHandler } from "./_broker.js";

export async function POST(request: Request): Promise<Response> {
  return refreshHandler(request);
}
