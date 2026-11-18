// Same real SQL/runtime acceptance path, with the additional reviewed repository.
process.env.WARPCORE_TEST_RELEASE_REPO='amd/gaia';
await import('./github-verified-flow.mjs');
