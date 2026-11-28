// Anchor и web3.js используют Buffer из Node. В браузере его нет — подкладываем.
import { Buffer } from "buffer";

if (!(globalThis as any).Buffer) (globalThis as any).Buffer = Buffer;
