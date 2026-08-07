import { ModelRuntime } from "@earendil-works/pi-coding-agent";
const mr = await ModelRuntime.create();
mr.registerProvider("agnesai", {
  api: "openai-completions",
  name: "Agnes",
  baseUrl: "https://api.agnes-ai.cn/v1",
  apiKey: "test-key",
  models: [{ id: "agnes-test-model", name: "agnes-test-model", contextWindow: 128000, maxTokens: 16384 }],
});
const available = await mr.getAvailable();
const agnes = available.filter(m => m.provider === "agnesai");
console.log("total available:", available.length);
console.log("agnes models:", JSON.stringify(agnes.map(m => ({ provider: m.provider, id: m.id }))));
