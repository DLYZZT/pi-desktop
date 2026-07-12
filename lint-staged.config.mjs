export default {
  "*.{ts,tsx,mjs}": ["eslint --fix --max-warnings=0", "prettier --write"],
  "*.{css,html,json,md,yaml,yml}": "prettier --write",
};
