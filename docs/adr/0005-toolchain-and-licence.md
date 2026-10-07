# ADR-0005: viem + Fastify + Foundry; Apache-2.0

**Status:** accepted (Phase 0)

* **viem** over ethers: typed ABIs, typed-data signing and error decoding without extra libraries; smaller surface to audit.
* **Fastify** over Express: schema-first, fast, first-class `preHandler` which is exactly the shape of the payee middleware.
* **Foundry** over Hardhat: fuzzing and invariant testing are table stakes for a contract that guards money; `forge test` runs 512 fuzz runs and invariants in under a second.
* **pnpm workspaces**: one repo for contracts, core, gateway, payee, SDK, MCP server, CLI, examples. Packages are publishable independently.
* **Apache-2.0**: the only open on-chain guardrail project today is BUSL; neutrality needs a licence vendors can adopt without legal review. Patent grant matters for a payments project.
* **Zod** for every wire schema so the rail formats are validated at the boundary and documented by the types.
* **Node ≥ 20.17**: Node 22 is preferred; 20.17 is the floor because of `fetch` and `parseArgs`.
