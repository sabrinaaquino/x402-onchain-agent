#!/usr/bin/env node
// Generate a fresh throwaway wallet for the workshop x402 demo.
// Prints the address + private key. NEVER use this wallet for real funds.
//
//   npm run keygen

import { Wallet } from "ethers";

const wallet = Wallet.createRandom();

console.log("\n  Fresh demo wallet (Base / EVM)\n");
console.log("  Address     :", wallet.address);
console.log("  Private key :", wallet.privateKey);
console.log("\n  Next steps:");
console.log("   1. Fund it with a little ETH (gas) + USDC on Base, OR link it to a");
console.log("      Venice account with DIEM. Top up with: venice.topUp(10) or POST /x402/top-up.");
console.log("   2. Put the key in .env.local as WALLET_PRIVATE_KEY=...");
console.log("      (better: encrypt it — `npm run encrypt-key`)");
console.log("   3. Set VENICE_AUTH_MODE=x402\n");
console.log("  ⚠  This key is printed in plaintext. Treat it as disposable.\n");
