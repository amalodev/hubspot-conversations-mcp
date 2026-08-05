import { configHandler } from "./_broker.js";

export async function GET(): Promise<Response> {
  return configHandler();
}
