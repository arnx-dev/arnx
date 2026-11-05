// A file's text with a stand-in for each of its suspects, as a snapshot gives them.
import { fakeAll, suspects } from "../../src/secrets";

export const standIn = (text: string, pins: readonly string[], path = "") => fakeAll(text, suspects(path, text, pins), pins);
