import { Memory } from "@mastra/memory";
import { mastraStorage } from "../../runtime.ts";
export default new Memory({ ...(mastraStorage ? { storage: mastraStorage } : {}), options: { lastMessages: 20 } });
