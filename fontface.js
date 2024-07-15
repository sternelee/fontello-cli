// Create @fontface text for CSS
//
"use strict";

const _ = require("lodash");
const svg2ttf = require("svg2ttf");
const b64 = require("base64-js");
const fs = require("fs");

module.exports = function (svg, fontId) {
	if (!svg) {
		return;
	}

	console.log(svg);
	const ttf = svg2ttf(svg, {}).buffer;
	fs.writeFileSync("iconfont.svg", svg, "utf8");
	fs.writeFileSync("iconfont.ttf", ttf, "utf8");
	const fontInfo = {
		ttfDataUri: "data:font/truetype;base64," + b64.fromByteArray(ttf),
		fontId,
	};

	const fontfaceTemplate =
		"  @font-face {\n" +
		'    font-family: "${fontId}";\n' +
		'    src: url("${ttfDataUri}") format("truetype");\n' +
		"    font-weight: normal;\n" +
		"    font-style: normal;\n" +
		"  }\n";
	return _.template(fontfaceTemplate)(fontInfo);
};
