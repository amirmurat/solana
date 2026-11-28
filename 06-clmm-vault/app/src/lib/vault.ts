// Клиент для vault из vault-config.json. null — сайт ещё не настроен.
import { Connection } from "@solana/web3.js";
import { PROGRAM_ID, RPC_URL, TOKEN_MINT } from "../config";
import { makeClient } from "./client";

export const connection = new Connection(RPC_URL, "confirmed");
export const client = PROGRAM_ID && TOKEN_MINT ? makeClient(connection, PROGRAM_ID, TOKEN_MINT) : null;
