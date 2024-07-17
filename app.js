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
const ko = require("knockout");
const crypto = require("crypto");
const XMLDOMParser = require("@xmldom/xmldom").DOMParser;

const codesTracker = require("./codes_tracker");
const namesTracker = require("./names_tracker");
const svg_image_flatten = require("./svg_image_flatten");
const utils = require("./utils");
const embedded_fonts = require("./client_config");

const N = {
  fontname: "fontello",
  fullname: "Fontello Icons",
  files: {
    html: "dist/fontello.html",
    svg: "dist/fontello.svg",
    ttf: "dist/fontello.ttf",
    eot: "dist/fontello.eot",
    woff: "dist/fontello.woff",
    woff2: "dist/fontello.woff2",
  },
};

N.fontsList = new FontsList();
N.fontSize = ko.observable(16);
N.hinting = ko.observable(true);
// N.encoding = ko.observable('pua');

// Font Params
//
N.fontName = ko.observable("");
N.cssPrefixText = ko.observable("icon-");
N.cssUseSuffix = ko.observable(false);
// This font params needed only if one wish to create custom font,
// or play with baseline. Can be tuned via advanced settings
N.fontUnitsPerEm = ko.observable(1000);
N.fontAscent = ko.observable(850);
N.fontFullName = ko.observable("");
N.fontCopyright = ko.observable("");

N.getConfig = function () {
  const config = {
    name: N.fontName().trim(),
    css_prefix_text: N.cssPrefixText().trim(),
    css_use_suffix: N.cssUseSuffix(),
    hinting: N.hinting(),
    units_per_em: N.fontUnitsPerEm(),
    ascent: N.fontAscent(),
  };

  if (!_.isEmpty(N.fontCopyright())) {
    config.copyright = $.trim(N.fontCopyright());
  }
  if (!_.isEmpty(N.fontFullName())) {
    config.fullname = $.trim(N.fontFullName());
  }

  config.glyphs = [];

  // add selected glyphs first to keep selection order
  _.forEach(N.fontsList.selectedGlyphs(), (glyph) => {
    config.glyphs.push(glyph.serialize());
  });

  // add custom icons (if not elected yet)
  _(N.fontsList.fonts)
    .filter({ fontname: "fontello" })
    .forEach((font) => {
      _.forEach(font.glyphs, (glyph) => {
        if (!glyph.selected()) config.glyphs.push(glyph.serialize());
      });
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
  this.md5 = data.md5;

  //
  // Helper properties
  //

  this.font = parent;

  this.charRef = utils.fixedFromCharCode(data.charRef);

  //
  // Actual properties state
  //
  // actual `selected` value will be set after codes/names trackers init
  this.selected = ko.observable(false);
  this.name = ko.observable(this.originalName);
  this.code = ko.observable(this.originalCode);

  this.svg = data.svg;
  // Change glyph selection
  //
  this.toggleSelect = function (value) {
    self.selected(value);

    if (value) {
      self.font.fontsList.selectedGlyphs.push(self);
    } else {
      self.font.fontsList.selectedGlyphs.remove(self);
    }
  };

  // Serialization. Make sure to update this method to have
  // desired fields sent to the server (by font builder).
  //
  this.serialize = function () {
    const res = {
      uid: self.uid,
      name: self.name(),
      code: self.code(),
      md5: self.md5,
      src: self.font.fontname,
    };

    if (self.font.fontname === "fontello") {
      res.selected = self.selected();
      res.svg = self.svg;
    }

    return res;
  };
  this.remove = function () {
    self.font.removeGlyph(self.uid);
  };
  // Do selection before attaching remapper, to keep codes
  // on config import
  this.toggleSelect(!!data.selected);

  // FIXME: do better cleanup on glyph remove
  // Register glyph in the names/codes swap-remap handlers.
  //
  codesTracker.observeGlyph(this);
  namesTracker.observeGlyph(this);
}

function FontModel(data, parent) {
  const self = this;

  this.fontsList = parent;

  //
  // Essential properties
  //
  this.fullname = (data.font || {}).fullname;
  this.fontname = (data.font || {}).fontname; // also used as font id
  this.version = (data.font || {}).version;

  //
  // View state properties
  //

  this.collapsed = ko.observable(false);

  // Map for fast lookup
  // { id: glyph }
  this.glyphMap = {};

  // font glyphs array
  this.glyphs = [];

  this.addGlyph = function (data) {
    const glyph = new GlyphModel(data, this);

    this.glyphMap[glyph.uid] = glyph;

    parent.track(glyph);

    this.glyphs.push(glyph);

    return glyph;
  };

  this.removeGlyph = function (uid) {
    // when no param - remove all
    if (!uid) {
      self.glyphs.slice().forEach(function (g) {
        self.removeGlyph(g.uid);
      });
      return;
    }

    self.glyphMap[uid].toggleSelect(false);

    parent.untrack(this.glyphMap[uid]);

    const idx = _.findIndex(self.glyphs, function (g) {
      return g.uid === uid;
    });
    if (idx !== -1) {
      self.glyphs.splice(idx, 1);
    }
    // self.glyphs.valueHasMutated();

    delete self.glyphMap[uid];
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
    conf.font.ascent = +(
      (N.fontAscent() * 1000) /
      N.fontUnitsPerEm()
    ).toFixed(0);
    conf.font.descent = conf.font.ascent - 1000;

    conf.glyphs = _.map(this.glyphs, function (glyph) {
      return {
        name: glyph.originalName,
        code: glyph.charRef.charCodeAt(0),

        d: new SvgPath(glyph.svg.path)
          .scale(1, -1)
          .translate(0, conf.font.ascent)
          .abs()
          .round(1)
          .toString(),

        width: glyph.svg.width,
      };
    });

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

  //
  // Init
  //

  // Load glyphs
  //
  _.forEach(data.glyphs, function (glyphData) {
    self.addGlyph(glyphData);
  });
}

////////////////////////////////////////////////////////////////////////////////

function FontsList() {
  const self = this;
  this.fonts = [];

  // Map for fast glyph lookup
  // { id: glyph }
  this.glyphMap = {};

  // Array of selected glyphs from all fonts
  //
  this.selectedGlyphs = ko.observableArray();

  this.track = function (glyph) {
    this.glyphMap[glyph.uid] = glyph;
  };

  this.untrack = function (glyph) {
    delete self.glyphMap[glyph.uid];
  };

  //
  // Init
  //

  // Create custom icons stub
  this.fonts.push(
    new FontModel(
      {
        font: { fontname: N.fontname, fullname: N.fullname },
      },
      self
    )
  );

  // Ordered list, to display on the page
  this.fonts.push.apply(
    this.fonts,
    _.map(embedded_fonts, function (data) {
      return new FontModel(data, self);
    })
  );

  this.unselectAll = function () {
    this.selectedGlyphs
      .peek()
      .slice()
      .forEach(function (glyph) {
        glyph.selected(false);
      });
    this.selectedGlyphs.removeAll();
  };

  // Search font by name
  //
  this.getFont = function (name) {
    return _.find(this.fonts, function (font) {
      return font.fontname === name;
    });
  };

  this.getGlyph = function (uid) {
    return this.glyphMap[uid];
  };

  // Register font list in the names/codes swap-remap handlers.
  //
  codesTracker.observeFontsList(this);
  namesTracker.observeFontsList(this);
}

//
// Import config
//
// str  - JSON data
//
function import_config(str) {
  try {
    const config = JSON.parse(str);
    const getFont = _.memoize(function (name) {
      return N.fontsList.getFont(name);
    });
    const customIcons = getFont("fontello");
    const maxRef = _.maxBy(customIcons.glyphs, function (glyph) {
      return utils.fixedCharCodeAt(glyph.charRef);
    });

    let allocatedRefCode = !maxRef
      ? 0xe800
      : utils.fixedCharCodeAt(maxRef.charRef) + 1;

    N.fontName(config.name || "");
    N.cssPrefixText(String(config.css_prefix_text || "icon-"));
    N.cssUseSuffix(config.css_use_suffix === true);
    N.hinting(config.hinting !== false); // compatibility with old configs

    N.fontUnitsPerEm(Number(config.units_per_em) || 1000);
    N.fontAscent(Number(config.ascent) || 850);

    // Patch broken data to fix original config
    if (config.fullname === "undefined") {
      delete config.fullname;
    }
    if (config.copyright === "undefined") {
      delete config.copyright;
    }

    N.fontFullName(String(config.fullname || ""));
    N.fontCopyright(String(config.copyright || ""));

    // reset selection prior to set glyph data
    N.fontsList.unselectAll();

    // remove custom glyphs
    customIcons.removeGlyph();

    // create map to lookup glyphs by id
    const glyphById = {};
    _.each(N.fontsList.fonts, function (font) {
      _.each(font.glyphs, function (glyph) {
        glyphById[glyph.uid] = glyph;
      });
    });

    _.each(config.glyphs, function (g) {
      let glyph;

      if (!getFont(g.src)) {
        return;
      }

      if (g.src === "fontello") {
        glyph = customIcons.addGlyph({
          uid: g.uid,
          name: g.name,
          code: g.code,
          md5: g.md5,
          charRef: allocatedRefCode++,
          selected: g.selected,
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

      glyph.toggleSelect(true);
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

  const customIcons = N.fontsList.getFont("fontello");
  const isExist = _.findIndex(customIcons.glyphs, function (g) {
    return g.md5 === file.md5;
  });
  if (isExist !== -1) return;
  console.log('Running:', file)

  // Allocate reference code, used to show generated font on fontello page
  // That's for internal needs, don't confuse with glyph (model) code
  const maxRef = _.maxBy(customIcons.glyphs, function (glyph) {
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

    customIcons.addGlyph({
      name: glyphName,
      code: glyphCode,
      charRef: allocatedRefCode++,
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
  const customIcons = N.fontsList.getFont("fontello");

  const isExist = _.findIndex(customIcons.glyphs, function (g) {
    return g.md5 === file.md5;
  });
  if (isExist !== -1) return;
  console.log('Running:', file)

  // Allocate reference code, used to show generated font on fontello page
  // That's for internal needs, don't confuse with glyph (model) code
  const maxRef = _.maxBy(customIcons.glyphs, function (glyph) {
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
    console.info("err_skipped_tags");
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

  customIcons.addGlyph({
    name: glyphName,
    code: allocatedRefCode,
    charRef: allocatedRefCode++,
    md5: file.md5,
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

async function export_fonts(font_name = "fontello") {
  const customIcons = N.fontsList.getFont(font_name);
  if (!customIcons.glyphs.length) {
    return;
  }
  let ttf;
  const svgOutput = customIcons.makeSvgFont();
  try {
    ttf = svg2ttf(svgOutput, {
      copyright: "Copyright (C) 2012 by Fontello project",
    }).buffer;
  } catch (err) {
    /* eslint-disable-next-line no-console */
    console.log(err);
    return;
  }

  await write(N.files.svg, svgOutput, 'utf8');

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

async function export_html(font_name = "fontello") {
  const customIcons = N.fontsList.getFont(font_name);
  if (!customIcons.glyphs.length) {
    return;
  }
  const templateTtml = await read('./template_en.html', 'utf8');
  const htmlTemplate = _.template(templateTtml);

  const glyphs = [];
  _.forEach(customIcons.glyphs, (glyph) => {
    glyphs.push(glyph.serialize());
  });

  const htmlString = htmlTemplate({
    glyphs: _.sortBy(glyphs, ['code']).reverse()
  });

  await write(N.files.html, htmlString, 'utf8');
}

function make_svg_font(font_name = "fontello") {
  const customIcons = N.fontsList.getFont(font_name);

  if (!customIcons.glyphs.length) {
    return;
  }
  let ff;

  try {
    ff = fontface(customIcons.makeSvgFont(), customIcons.fontname);
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
    fontId: customIcons.fontname,
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
          const file = { name, md5: hash.digest("hex"), filePath };
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
