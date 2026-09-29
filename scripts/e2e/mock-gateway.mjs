// A scriptable OpenAI Chat Completions gateway for end-to-end runs.
//
// The newest user message that carries a `MOCK:[...]` script drives the
// conversation. Anything before it on the line is a label, which also becomes
// the session title, so scenarios can find the conversation in the sidebar:
//
//   会话一 MOCK:[{"tool":"browser_open","args":{"url":"http://..."}}, {"echo":true}]
//
// Each assistant turn after that message plays the next step:
//   {"tool": name, "args": {...}}   one tool call (a `purpose` is filled in)
//   {"tools": [{tool, args}, ...]}  several tool calls in one turn
//   {"text": "..."}                 a final text answer
//   {"echo": true}                  a text answer quoting the last tool result
// Past the last step the model answers with the last tool result, then stops.
// Requests with no tools (session titles, summaries) get a short text: the
// label when there is one. Subagent requests follow the script in their task.
import { appendFileSync } from "node:fs";
import { createServer } from "node:http";

function textOf(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((part) => (typeof part === "string" ? part : part?.text ?? "")).join("\n");
  return "";
}

function directiveIndex(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role === "user" && /MOCK:\[/.test(textOf(message.content))) return index;
  }
  return -1;
}

function parseSteps(text) {
  const line = text.split("\n").find((entry) => entry.includes("MOCK:["));
  return JSON.parse(line.slice(line.indexOf("MOCK:[") + "MOCK:".length));
}

function lastToolResult(messages) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === "tool") return textOf(messages[index].content);
  }
  return "";
}

export function planTurn(body) {
  const messages = body.messages ?? [];
  // 标题、摘要这类请求不带工具，但会把用户原话（连同 MOCK 行）转述进来。
  if (!body.tools?.length) {
    // 标题请求里带着用户原话；消息开头 MOCK 前面的那个词就当标题，侧栏里好认。
    const label = /(\S+)\s+MOCK:\[/.exec(messages.map((message) => textOf(message.content)).join("\n"))?.[1];
    return { text: label ?? "E2E 会话" };
  }
  const at = directiveIndex(messages);
  if (at < 0) return { text: "E2E 会话" };
  const steps = parseSteps(textOf(messages[at].content));
  const played = messages.slice(at + 1).filter((message) => message.role === "assistant").length;
  const step = steps[played];
  if (!step) return { text: `（剧本结束）上一步工具返回：\n${lastToolResult(messages).slice(0, 1500)}` };
  if (step.echo) return { text: `工具返回：\n${lastToolResult(messages).slice(0, 1500)}` };
  if (step.text) return { text: step.text };
  const calls = step.tools ?? [step];
  return {
    toolCalls: calls.map((call, index) => ({
      id: `call_${Date.now()}_${played}_${index}`,
      name: call.tool,
      arguments: JSON.stringify({ purpose: "端到端测试", ...(call.args ?? {}) }),
    })),
  };
}

function chunk(model, delta, finish) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [{ index: 0, delta, finish_reason: finish ?? null }],
  })}\n\n`;
}

export async function startMockGateway({ port = 0, log, models = [{ id: "mock-1", name: "Mock 1" }] } = {}) {
  const server = createServer(async (request, response) => {
    const path = (request.url ?? "").split("?", 1)[0];
    if (request.method === "GET" && path.endsWith("/models")) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ data: models }));
      return;
    }
    if (request.method !== "POST" || !path.endsWith("/chat/completions")) {
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `not found: ${path}` } }));
      return;
    }
    let raw = "";
    for await (const part of request) raw += part;
    const body = JSON.parse(raw);
    const turn = planTurn(body);
    if (log) {
      appendFileSync(log, `${JSON.stringify({
        at: new Date().toISOString(),
        tools: (body.tools ?? []).map((tool) => tool.function?.name),
        system: textOf(body.messages?.find((message) => message.role === "system")?.content).slice(0, 200),
        systemTail: textOf(body.messages?.find((message) => message.role === "system")?.content).slice(-400),
        last: (() => { const message = body.messages?.at(-1); return { role: message?.role, text: textOf(message?.content).slice(0, 300) }; })(),
        turn,
      })}\n`);
    }
    const model = body.model ?? "mock-1";
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    response.write(chunk(model, { role: "assistant" }));
    if (turn.toolCalls) {
      turn.toolCalls.forEach((call, index) => {
        response.write(chunk(model, { tool_calls: [{ index, id: call.id, type: "function", function: { name: call.name, arguments: call.arguments } }] }));
      });
      response.write(chunk(model, {}, "tool_calls"));
    } else {
      for (const piece of turn.text.match(/[\s\S]{1,40}/g) ?? [""]) response.write(chunk(model, { content: piece }));
      response.write(chunk(model, {}, "stop"));
    }
    response.write(`data: ${JSON.stringify({ id: "chatcmpl-e2e", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model, choices: [], usage: { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120 } })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  const address = server.address();
  return { server, baseUrl: `http://127.0.0.1:${address.port}/v1` };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const { baseUrl } = await startMockGateway({ port: Number(process.env.PORT ?? 0), log: process.env.LOG });
  console.log(baseUrl);
}
