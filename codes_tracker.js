"use strict";

var UNICODE_CODES_MIN = 0x0;
var UNICODE_CODES_MAX = 0x10ffff;

var UNICODE_PRIVATE_USE_AREA_MIN = 0xe800;
var UNICODE_PRIVATE_USE_AREA_MAX = 0xf8ff;

var ASCII_PRINTABLE_MIN = 0x21;
var ASCII_PRINTABLE_MAX = 0x7e;

// Restricted glyph codes.
// http://www.w3.org/TR/xml11/#charsets
//
var RESTRICTED_BLOCK_MIN = 0xd800;
var RESTRICTED_BLOCK_MAX = 0xdfff;

var RESTRICTED_SINGLE_CODES = {};

[
  0x0, 0x1, 0x2, 0x3, 0x4, 0x5, 0x6, 0x7, 0x8, 0xb, 0xc, 0xe, 0xf,

  0x10, 0x11, 0x12, 0x13, 0x14, 0x15, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x1b, 0x1c,
  0x1d, 0x1e, 0x1f,

  0x7f, 0x80, 0x81, 0x82, 0x83, 0x84,

  0x86, 0x87, 0x88, 0x89, 0x8a, 0x8b, 0x8c, 0x8d, 0x8e, 0x8f, 0x90, 0x91, 0x92,
  0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f,

  0xfdd0, 0xfdd1, 0xfdd2, 0xfdd3, 0xfdd4, 0xfdd5, 0xfdd6, 0xfdd7, 0xfdd8,
  0xfdd9, 0xfdda, 0xfddb, 0xfddc, 0xfddd, 0xfdde, 0xfddf,

  0xfffe, 0xffff, 0x1fffe, 0x1ffff, 0x2fffe, 0x2ffff, 0x3fffe, 0x3ffff, 0x4fffe,
  0x4ffff, 0x5fffe, 0x5ffff, 0x6fffe, 0x6ffff, 0x7fffe, 0x7ffff, 0x8fffe,
  0x8ffff, 0x9fffe, 0x9ffff, 0xafffe, 0xaffff, 0xbfffe, 0xbffff, 0xcfffe,
  0xcffff, 0xdfffe, 0xdffff, 0xefffe, 0xeffff, 0xffffe, 0xfffff, 0x10fffe,
  0x10ffff,
].forEach(function (code) {
  RESTRICTED_SINGLE_CODES[code] = true;
});

// Hash table used to keep control on automatic glyph code assignment when user
// selects/deselects some glyphs. Keys are glyph codes. Values are instances of
// GlyphModel. See app.js for details.
var usedCodes = {};

// Returns true if code is valid and not used.
//
function checkValidCode(code) {
  return (
    code >= UNICODE_CODES_MIN &&
    code <= UNICODE_CODES_MAX &&
    (code < RESTRICTED_BLOCK_MIN || code > RESTRICTED_BLOCK_MAX) &&
    !RESTRICTED_SINGLE_CODES[code]
  );
}

// Returns first available and valid code in the range.
//
function findCode(min, max) {
  for (var code = min; code <= max; code += 1) {
    if (
      checkValidCode(code) &&
      (!usedCodes[code] || !usedCodes[code].selected())
    ) {
      return code;
    }
  }
  return -1;
}

// Returns first available and valid code in the Unicode Private Use Area.
//
function findPrivateUseArea(preferredCode) {
  if (
    preferredCode &&
    checkValidCode(preferredCode) &&
    (!usedCodes[preferredCode] || !usedCodes[preferredCode].selected()) &&
    preferredCode >= UNICODE_PRIVATE_USE_AREA_MIN &&
    preferredCode <= UNICODE_PRIVATE_USE_AREA_MAX
  ) {
    return preferredCode;
  }

  var code = findCode(
    UNICODE_PRIVATE_USE_AREA_MIN,
    UNICODE_PRIVATE_USE_AREA_MAX,
  );

  if (code !== -1) {
    return code;
  }

  // Should never happen.
  throw new Error("Free glyph codes in the Private Use Area are run out.");
}

// Returns first available and valid printable ASCII code.
// Fallbacks to findPrivateUseArea()
//
function findAscii(preferredCode) {
  if (
    preferredCode &&
    checkValidCode(preferredCode) &&
    (!usedCodes[preferredCode] || !usedCodes[preferredCode].selected()) &&
    preferredCode >= ASCII_PRINTABLE_MIN &&
    preferredCode <= ASCII_PRINTABLE_MAX
  ) {
    return preferredCode;
  }

  var code = findCode(ASCII_PRINTABLE_MIN, ASCII_PRINTABLE_MAX);

  return code !== -1 ? code : findPrivateUseArea();
}

// Returns the given code if it is available and valid.
// Fallbacks to findPrivateUseArea()
//
function findUnicode(code) {
  if (
    checkValidCode(code) &&
    (!usedCodes[code] || !usedCodes[code].selected())
  ) {
    return code;
  }

  return findPrivateUseArea();
}

//
function allocateCode(glyph, encoding) {
  var oldCode = glyph.code();
  var newCode;

  if (usedCodes[oldCode] === glyph) usedCodes[oldCode] = null;

  switch (encoding) {
    case "pua":
      newCode = findPrivateUseArea(oldCode);
      break;

    case "ascii":
      newCode = findAscii(oldCode);
      break;

    case "unicode":
      newCode = findUnicode(oldCode);
      break;

    default:
      throw new Error("Unknown glyph enumerator: " + encoding);
  }

  glyph.code(newCode);

  // Ensure code is marks as 'used' for the glyph. It's needed in cases when
  // default glyph code is equal to an allocated one - so automatic allocation
  // does not work.
  usedCodes[newCode] = glyph;
}

function observeGlyph(glyph) {
  var previousCode = glyph.code();

  // If new glyph created with "selected" flag,
  // mark it's code as allocated
  //
  // Also, fix code if busy, however, that should not happen
  //
  if (glyph.selected()) {
    // unicode -> don't try to remap by default
    allocateCode(glyph, "unicode");
  }

  // Keep track on previous code value.
  glyph.code.subscribe(
    function (code) {
      previousCode = code;

      if (usedCodes[code] === this) {
        usedCodes[code] = null;
      }
    },
    glyph,
    "beforeChange",
  );

  // When user set the glyph code to a used one - swap them.
  glyph.code.subscribe(function (code) {
    if (this.selected()) {
      if (
        usedCodes[code] &&
        usedCodes[code] !== this &&
        usedCodes[code].selected()
      ) {
        usedCodes[code].code(previousCode);
      }

      usedCodes[code] = this;

      // If user enters an invalid code - notify and rollback.
      if (!checkValidCode(code)) {
        /* eslint-disable max-depth */
        if (checkValidCode(previousCode)) {
          this.code(previousCode);
        } else {
          if (usedCodes[this.code()] === glyph) usedCodes[this.code()] = null;
          this.code(findUnicode(this.originalCode));
        }
      }
    }
  }, glyph);
}

function observeFontsList(fontsList) {
  // When user selects/deselects the glyph - allocate/free a code.
  fontsList.selectedGlyphs.subscribe(
    function (changes) {
      changes.forEach(({ status, value }) => {
        if (value._imported) {
          // ignore first event if this glyph was just imported
          value._imported = false;
          return;
        }

        if (status === "added") {
          if (value.code() === value.originalCode) {
            allocateCode(value, "pua");
          } else {
            // If code modified by user - don't try to remap
            allocateCode(value, "unicode");
          }
        } else {
          usedCodes[value.code()] = null;
        }
      });
    },
    fontsList,
    "arrayChange",
  );
}

module.exports = {
  observeGlyph, observeFontsList
};
