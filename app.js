"use strict";

const promisify = require("util").promisify;
const fs = require("fs");
const write = promisify(fs.writeFile);
const read = promisify(fs.readFile);
const path = require("path");
const SvgPath = require("svgpath");
const _ = require("lodash");
const svg2ttf = require("svg2ttf");
const ttf2eot = require("ttf2eot");
const ttf2woff = require("ttf2woff");
const wawoff2 = require("wawoff2");
const b64 = require("base64-js");
const crypto = require("crypto");
const XMLDOMParser = require("@xmldom/xmldom").DOMParser;

const svg_image_flatten = require("./svg_image_flatten");
const utils = require("./utils");

const N = {
  fontname: "fontello",
  fullname: "Fontello Icons",
  fontName: "",
  // This font params needed only if one wish to create custom font,
  // or play with baseline. Can be tuned via advanced settings
  fontUnitsPerEm: 1000,
  fontAscent: 850,

  fontSize: 16,
  encoding: "pua",
  files: {
    html: "dist/fontello.html",
    svg: "dist/fontello.svg",
    ttf: "dist/fontello.ttf",
    eot: "dist/fontello.eot",
    woff: "dist/fontello.woff",
    woff2: "dist/fontello.woff2",
  }
};

N.fontModel = new FontModel(
  { fontname: N.fontname, fullname: N.fullname });

// Font Params
//
N.getConfig = function () {
  const config = {
    name: N.fontName.trim(),
    units_per_em: N.fontUnitsPerEm,
    ascent: N.fontAscent,
  };

  config.glyphs = [];

  // add custom icons (if not elected yet)
  N.fontModel.glyphs.forEach((glyph) => {
    glyph.selected && config.glyphs.push(glyph.serialize());
  });

  return config;
};

const splitPathRe =
  /^(\/?|)([\s\S]*?)((?:\.{1,2}|[^\/]+?|)(\.[^.\/]*|))(?:[\/]*)$/;
function splitPath(filename) {
  return splitPathRe.exec(filename).slice(1);
}
function basename(path, ext) {
  let f = splitPath(path)[2];
  // TODO: make this comparison case-insensitive on windows?
  if (ext && f.substr(-1 * ext.length) === ext) {
    f = f.substr(0, f.length - ext.length);
  }
  return f;
}
function uid() {
  /*eslint-disable no-bitwise*/
  return "xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx".replace(/[x]/g, function () {
    return ((Math.random() * 16) | 0).toString(16);
  });
}

function fontface(svg, fontId) {
  if (!svg) {
    return;
  }

  const ttf = svg2ttf(svg, {}).buffer;
  const fontInfo = {
    ttfDataUri: "data:font/truetype;base64," + b64.fromByteArray(ttf),
    fontId,
  };

  const fontfaceTemplate =
    "  @font-face {\n" +
    '    font-family: "fml_${fontId}";\n' +
    '    src: url("${ttfDataUri}") format("truetype");\n' +
    "    font-weight: normal;\n" +
    "    font-style: normal;\n" +
    "  }\n";
  return _.template(fontfaceTemplate)(fontInfo);
}

function GlyphModel(data, parent) {
  const self = this;

  // Read-only properties
  //
  this.uid = data.uid || uid();
  this.originalName = data.name;
  this.originalCode = data.code;
  this.selected = data.selected || false;

  //
  // Helper properties
  //

  this.font = parent;

  this.charRef = utils.fixedFromCharCode(data.charRef);

  //
  // Actual properties state
  //
  this.name = this.originalName;
  this.code = this.originalCode;

  this.svg = data.svg;
  // Change glyph selection
  //
  // Serialization. Make sure to update this method to have
  // desired fields sent to the server (by font builder).
  //
  this.serialize = function () {
    const res = {
      uid: self.uid,
      name: self.name,
      code: self.code,
      src: self.font.fontname,
    };

    if (self.font.fontname === N.fontname) {
      res.svg = self.svg;
    }

    return res;
  };
  // FIXME: do better cleanup on glyph remove
  // Register glyph in the names/codes swap-remap handlers.
  //
}

function FontModel(data) {
  const self = this;
  //
  // Essential properties
  //
  this.fullname = (data || {}).fullname;
  this.fontname = (data || {}).fontname; // also used as font id
  this.version = (data || {}).version;

  //
  // View state properties
  //

  this.collapsed = false;

  // Map for fast lookup
  // { id: glyph }
  this.glyphMap = {};

  // font glyphs array
  this.glyphs = [];

  this.addGlyph = function (data) {
    const glyph = new GlyphModel(data, this);

    this.glyphMap[glyph.uid] = glyph;

    this.glyphs.push(glyph);

    return glyph;
  };

  //
  // Helpers
  //

  this.makeSvgFont = function () {
    if (!this.glyphs.length) {
      return;
    }

    const conf = {};
    conf.font = {};
    conf.font.fontname = this.fontname;
    conf.font.familyname = this.fontname;

    // We always make font in 1000 units per em grid. So, if user
    // changes metrics - recalculate ascent/descent to get tha same baseline.
    //
    conf.font.ascent = +((N.fontAscent * 1000) / N.fontUnitsPerEm).toFixed(0);
    conf.font.descent = conf.font.ascent - 1000;

    conf.glyphs = this.glyphs.map(function (glyph) {
      return {
        name: glyph.originalName,
        code: glyph.charRef.charCodeAt(0),
        selected: glyph.selected,

        d: new SvgPath(glyph.svg.path)
          .scale(1, -1)
          .translate(0, conf.font.ascent)
          .abs()
          .round(1)
          .toString(),

        width: glyph.svg.width,
      };
    }).filter(v => v.selected);

    const svgFontTemplate = _.template(
      '<?xml version="1.0" standalone="no"?>\n' +
      '<!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n' +
      '<svg xmlns="http://www.w3.org/2000/svg">\n' +
      "<defs>\n" +
      '<font id="_${font.fontname}" horiz-adv-x="${font.ascent - font.descent}" >\n' +
      "<font-face" +
      ' font-family="${font.familyname}"' +
      ' font-weight="400"' +
      ' font-stretch="normal"' +
      ' units-per-em="${font.ascent - font.descent}"' +
      ' ascent="${font.ascent}"' +
      ' descent="${font.descent}"' +
      " />\n" +
      '<missing-glyph horiz-adv-x="${font.ascent - font.descent}" />\n' +
      "<% glyphs.forEach(function(glyph) { %>" +
      "<glyph" +
      ' glyph-name="${glyph.name}"' +
      ' unicode="&#x${glyph.code.toString(16)};"' +
      ' d="${glyph.d}"' +
      ' horiz-adv-x="${glyph.width}"' +
      " />\n" +
      "<% }); %>" +
      "</font>\n" +
      "</defs>\n" +
      "</svg>"
    );

    return svgFontTemplate(conf);
  };

}

//
// Import config
//
// str  - JSON data
//
function import_config(str) {
  try {
    const config = JSON.parse(str);
    const maxRef = _.maxBy(N.fontModel.glyphs, function (glyph) {
      return utils.fixedCharCodeAt(glyph.charRef);
    });

    let allocatedRefCode = !maxRef
      ? 0xe800
      : utils.fixedCharCodeAt(maxRef.charRef) + 1;

    N.fontName = config.name || "";

    N.fontUnitsPerEm = Number(config.units_per_em) || 1000;
    N.fontAscent = Number(config.ascent) || 850;

    // create map to lookup glyphs by id
    const glyphById = {};
    _.each(N.fontModel.glyphs, function (glyph) {
      glyphById[glyph.uid] = glyph;
    });

    _.each(config.glyphs, function (g) {
      let glyph;

      if (g.src === N.fontname) {
        glyph = N.fontModel.addGlyph({
          uid: g.uid,
          name: g.name,
          code: g.code,
          charRef: allocatedRefCode++,
          selected: false,
          svg: {
            path: g.svg.path,
            width: g.svg.width,
          },
        });
        // flag this glyph as just imported to prevent overriding code in code_tracker
        glyph._imported = true;
        return;
      }

      glyph = glyphById[g.uid];

      if (!glyph) {
        return;
      }

      glyph.code(g.code || glyph.originalCode);
      glyph.name(g.name || glyph.originalName);
      // flag this glyph as just imported to prevent overriding code in code_tracker
      glyph._imported = true;
    });
  } catch (e) {
    /*eslint-disable no-console*/
    console.log(e);
  }
}

//
// Import svg fonts from svg files.
//
// data - text content
//

function import_svg_font(data, file) {
  const xmlDoc = new XMLDOMParser().parseFromString(data, "application/xml");

  const existIndex = _.findIndex(N.fontModel.glyphs, function (g) {
    return g.uid === file.uid;
  });
  if (existIndex !== -1) {
    N.fontModel.glyphs[existIndex].selected = true;
    return;
  }
  console.log("Running:", file);

  // Allocate reference code, used to show generated font on fontello page
  // That's for internal needs, don't confuse with glyph (model) code
  const maxRef = _.maxBy(N.fontModel.glyphs, function (glyph) {
    return utils.fixedCharCodeAt(glyph.charRef);
  });

  let allocatedRefCode = !maxRef
    ? 0xe800
    : utils.fixedCharCodeAt(maxRef.charRef) + 1;

  const svgFont = xmlDoc.getElementsByTagName("font")[0];
  const svgFontface = xmlDoc.getElementsByTagName("font-face")[0];
  const svgGlyps = xmlDoc.getElementsByTagName("glyph");

  const fontHorizAdvX = svgFont.getAttribute("horiz-adv-x");
  const fontAscent = svgFontface.getAttribute("ascent");
  const fontUnitsPerEm = svgFontface.getAttribute("units-per-em") || 1000;

  const scale = 1000 / fontUnitsPerEm;

  _.each(svgGlyps, function (svgGlyph) {
    const d = svgGlyph.getAttribute("d");

    // FIXME
    // Now just ignore glyphs without image, however
    // that can be space. Does anyone needs it?
    if (!d) {
      return;
    }

    const glyphCodeAsChar = svgGlyph.getAttribute("unicode");

    const glyphCode = glyphCodeAsChar
      ? utils.fixedCharCodeAt(glyphCodeAsChar)
      : 0xe800;
    const glyphName = svgGlyph.getAttribute("glyph-name") || "glyph";
    const glyphHorizAdvX = svgGlyph.hasAttribute("horiz-adv-x")
      ? svgGlyph.getAttribute("horiz-adv-x")
      : fontHorizAdvX;

    if (!glyphHorizAdvX) {
      return;
    } // ignore zero-width glyphs

    const width = glyphHorizAdvX * scale;

    // Translate font coonds to single SVG image coords
    d = new SvgPath(d)
      .translate(0, -fontAscent)
      .scale(scale, -scale)
      .abs()
      .round(1)
      .toString();

    N.fontModel.addGlyph({
      name: glyphName,
      code: glyphCode,
      charRef: allocatedRefCode++,
      selected: true,
      svg: {
        path: d,
        width,
      },
    });
  });
}

//
// Import svg image from svg files.
//
// data - text content
//

function import_svg_image(data, file) {
  const existIndex = _.findIndex(N.fontModel.glyphs, function (g) {
    return g.uid === file.uid;
  });
  if (existIndex !== -1) {
    N.fontModel.glyphs[existIndex].selected = true;
    return;
  }
  console.log("Running:", file);

  // Allocate reference code, used to show generated font on fontello page
  // That's for internal needs, don't confuse with glyph (model) code
  const maxRef = _.maxBy(N.fontModel.glyphs, function (glyph) {
    return utils.fixedCharCodeAt(glyph.charRef);
  });

  let allocatedRefCode = !maxRef
    ? 0xe800
    : utils.fixedCharCodeAt(maxRef.charRef) + 1;
  const result = svg_image_flatten(data);

  if (result.error) {
    /*eslint-disable no-console*/
    console.error("err_invalid_format:", result.error);
    return;
  }

  // Collect ignored tags and attrs
  // We need to have array with unique values because
  // some tags and attrs have same names (viewBox, style, glyphRef, title).
  //
  const skipped = _.union(result.ignoredTags, result.ignoredAttrs);

  if (skipped.length > 0) {
    console.info("err_skipped_tags:", skipped.toString());
  } else if (!result.guaranteed) {
    console.info("err_merge_path");
  }

  // Scale to standard grid
  const scale = 1000 / result.height;
  const d = new SvgPath(result.d)
    .translate(-result.x, -result.y)
    .scale(scale)
    .abs()
    .round(1)
    .toString();
  const width = Math.round(result.width * scale); // new width

  const glyphName = basename(file.name.toLowerCase(), ".svg").replace(
    /\s/g,
    "-"
  );

  N.fontModel.addGlyph({
    name: glyphName,
    code: allocatedRefCode,
    charRef: allocatedRefCode++,
    uid: file.uid,
    selected: true,
    svg: {
      path: d,
      width,
    },
  });
}

function export_config(dir) {
  const config = N.getConfig();
  const filePath = path.join(dir, "config.json");
  fs.writeFile(filePath, JSON.stringify(config), "utf8", (err) => {
    if (err) return;
    // console.log("Export font config.json");
  });
}

async function export_fonts(font_name = N.fontname) {
  let ttf;
  const svgOutput = N.fontModel.makeSvgFont();
  try {
    ttf = svg2ttf(svgOutput, {
      copyright: "Copyright (C) 2024 by Wati project",
    }).buffer;
  } catch (err) {
    /* eslint-disable-next-line no-console */
    console.log(err);
    return;
  }

  await write(N.files.svg, svgOutput, "utf8");

  // write ttf file
  await write(N.files.ttf, ttf);

  // write eot file
  let eotOutput = ttf2eot(ttf);

  await write(N.files.eot, eotOutput);

  // write woff file
  let woffOutput = ttf2woff(ttf);

  await write(N.files.woff, woffOutput);

  // Convert TTF to WOFF2.
  //
  let woff2Output = await wawoff2.compress(ttf);

  await write(N.files.woff2, woff2Output);
  export_html();
}

async function export_html(font_name = N.fontname) {
  const templateTtml = await read("./template_en.html", "utf8");
  const htmlTemplate = _.template(templateTtml);

  const glyphs = [];
  _.forEach(N.fontModel.glyphs, (glyph) => {
    glyph.selected && glyphs.push(glyph.serialize());
  });

  const htmlString = htmlTemplate({
    glyphs: _.sortBy(glyphs, ["code"]).reverse(),
  });

  await write(N.files.html, htmlString, "utf8");
}

function make_svg_font(font_name = N.fontname) {
  let ff;

  try {
    ff = fontface(N.fontModel.makeSvgFont(), N.fontModel.fontname);
  } catch (err) {
    /* eslint-disable-next-line no-console */
    console.log(err);
    return;
  }

  const styleTemplate = _.template(
    '<style id="ff_${fontId}" type="text/css">\n ${fontface}' +
    '  .font-${fontId} { font-family: "fml_${fontId}"; }\n' +
    "</style>\n"
  );

  const style = styleTemplate({
    fontface: ff,
    fontId: N.fontModel.fontname,
  });

  console.log(style);
}

const read_svg_files = async (dir) => {
  fs.readdir(dir, (_, files) => {
    const fileTotal = files.length;
    for (let i = 0; i < files.length; i++) {
      const filePath = path.join(dir, files[i]);
      if (path.extname(filePath) === ".svg") {
        fs.readFile(filePath, "utf8", (err, data) => {
          if (err) return;
          const name = path.basename(filePath);
          const hash = crypto.createHash("md5");
          hash.update(data);
          const file = { name, uid: hash.digest("hex"), filePath };
          if (data.indexOf("<font") + 1) {
            import_svg_font(data, file);
          } else {
            import_svg_image(data, file);
          }
          if (i === fileTotal - 1) {
            setTimeout(() => {
              export_config(dir);
              export_fonts();
            }, 1000);
          }
        });
      }
    }
  });
};

const read_config_json = async (dir) => {
  const filePath = path.join(dir, "config.json");
  fs.readFile(filePath, "utf8", (err, data) => {
    if (err) {
      read_svg_files(dir);
      return;
    }
    if (data) {
      import_config(data);
    }
    setTimeout(() => {
      read_svg_files(dir);
    }, 2000);
  });
};

read_config_json("./svg");
