// Pure helpers. No DOM, no Alpine, so they can be unit-tested later.

// 'hf.co/openbmb/MiniCPM5-2B-GGUF:Q4_K_M' -> 'openbmb/MiniCPM5-2B'
// The full name stays in `title` attributes and in the archive meta.
function shortName(name) {
    if (typeof name !== "string") return "";
    return name.replace(/^hf\.co\//, "").replace(/-GGUF:[^:\s]+$/i, "");
}

// 0 -> '01', 11 -> '12'
function pad2(index) {
    return String(index + 1).padStart(2, "0");
}
