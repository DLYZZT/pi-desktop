function isPiExtension(file) {
  return file.replaceAll("\\", "/").includes("/.pi/");
}

export default {
  "*.{ts,tsx,mjs}": (files) => {
    const product = files.filter((file) => !isPiExtension(file));
    const tasks = [];
    if (product.length > 0) {
      tasks.push(`eslint --fix --max-warnings=0 --no-warn-ignored ${product.join(" ")}`);
    }
    tasks.push(`prettier --write ${files.join(" ")}`);
    return tasks;
  },
  "*.{css,html,json,md,yaml,yml}": "prettier --write",
};
