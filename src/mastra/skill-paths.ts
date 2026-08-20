import { fileURLToPath } from "node:url";

export const GLOBAL_SKILLS_PATH = fileURLToPath(new URL("./skills", import.meta.url));
export const QASEY_MAIN_SKILLS_PATH = fileURLToPath(new URL("./agents/qasey-main/skills", import.meta.url));
