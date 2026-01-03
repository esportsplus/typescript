const BRACES_CONTENT_REGEX = /\{([^}]*)\}/;

const REGEX_ESCAPE_PATTERN = /[.*+?^${}()|[\]\\]/g;

const TRAILING_SEMICOLON = /;$/;

const TRANSFORM_PATTERN = /\.[tj]sx?$/;

const UUID_DASH_REGEX = /-/g;


export {
    BRACES_CONTENT_REGEX,
    REGEX_ESCAPE_PATTERN,
    TRAILING_SEMICOLON, TRANSFORM_PATTERN,
    UUID_DASH_REGEX,
};