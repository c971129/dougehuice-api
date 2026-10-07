"use strict";

// Keep CloudBase's configured handler CommonJS while loading the packaged
// Event implementation from its own ESM package scope.
exports.main = async (event, context) => {
  const handler = await import("./bundle/index.js");
  return handler.main(event, context);
};
