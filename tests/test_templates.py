"""
Structural checks for the rendered HTML.

The page is built from Jinja macros and Alpine <template> blocks. A missing or
extra closing tag fails nothing loudly: the browser repairs the tree silently
and a block ends up in the wrong place.
"""

from html.parser import HTMLParser

VOID = {
    "area", "base", "br", "col", "embed", "hr", "img",
    "input", "link", "meta", "source", "track", "wbr",
}  # fmt: skip


class _Balance(HTMLParser):
    def __init__(self):
        super().__init__()
        self.stack = []
        self.errors = []

    def handle_starttag(self, tag, attrs):
        if tag not in VOID:
            self.stack.append(tag)

    def handle_endtag(self, tag):
        if tag in VOID:
            return
        if not self.stack or self.stack[-1] != tag:
            self.errors.append(f"unexpected </{tag}> at line {self.getpos()[0]}")
            return
        self.stack.pop()


def test_index_html_tags_are_balanced(client):
    parser = _Balance()
    parser.feed(client.get("/").get_data(as_text=True))
    parser.close()

    assert parser.errors == []
    assert parser.stack == []
