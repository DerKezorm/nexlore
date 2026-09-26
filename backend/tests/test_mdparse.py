"""What the index reads out of a note: links with their exact place, tags, front matter, plugin syntax."""

from __future__ import annotations

from app.services import mdparse

NOTE = r"""---
title: Kickoff
tags: [project, "#planning"]
---
# Kickoff #meeting

See [[Roadmap#Q3|the roadmap]], ![[board.png]] and [spec](Specs/Big%20Spec.md#scope).
[ref]: <Specs/Other Spec.md>
Not a tag: page#anchor, #123, `#code` and `[[in code]]`.

```dataview
LIST FROM [[in dataview]]
```

    [[indented code]]

> [!warning] Careful
> [[Callout Link]] ==marked== %% [[commented]] %%

- [ ] open #todo
- [x] done
| a | b |
|---|---|
| [[Table Note\|shown]] | c |

rating:: 5
`= this.rating` and <% tp.date.now() %>
"""


def test_links_are_found_with_their_exact_place() -> None:
    parsed = mdparse.parse(NOTE)
    found = [(link.kind, link.target, link.subpath) for link in parsed.links]
    assert found == [
        ("wiki", "Roadmap", "Q3"),
        ("embed", "board.png", ""),
        ("md", "Specs/Big Spec.md", "scope"),
        ("md", "Specs/Other Spec.md", ""),
        ("wiki", "Callout Link", ""),
        ("wiki", "Table Note", ""),
    ]
    for link in parsed.links:
        written = NOTE[link.target_start : link.target_end]
        assert written in (link.target, "Specs/Big%20Spec.md"), written
    spec = parsed.links[2]
    assert spec.encoded and not spec.angle
    assert parsed.links[3].angle


def test_nothing_in_code_comments_or_plugin_blocks_counts() -> None:
    targets = {link.target for link in mdparse.parse(NOTE).links}
    assert not targets & {"in code", "in dataview", "indented code", "commented"}


def test_tags_from_front_matter_and_text_once_each() -> None:
    parsed = mdparse.parse(NOTE)
    assert parsed.tags == ["project", "planning", "meeting", "todo"]
    assert parsed.title == "Kickoff"
    assert parsed.front == {"title": "Kickoff", "tags": ["project", "#planning"]}


def test_tags_are_case_insensitive_and_nested() -> None:
    assert mdparse.parse("#Idea and #idea and #area/sub-topic/ and x#no").tags == ["Idea", "area/sub-topic"]


def test_features_for_the_import_report() -> None:
    features = mdparse.parse(NOTE).features
    assert features["dataview"] == 1
    assert features["dataview_inline"] == 1
    assert features["dataview_fields"] == 1
    assert features["templater"] == 1
    assert features["callouts"] == 1
    assert features["comments"] == 1
    assert features["highlights"] == 1
    assert features["tasks"] == 2 and features["tasks_open"] == 1
    assert features["embeds"] == 1


def test_front_matter_errors_are_reported_not_raised() -> None:
    parsed = mdparse.parse("---\ntags: [unclosed\n---\nbody [[Link]]")
    assert parsed.front is None and parsed.front_error
    assert parsed.features["front_matter_errors"] == 1
    assert [link.target for link in parsed.links] == ["Link"]
    assert mdparse.parse("---\n- a list\n---\n").front_error == "front matter is not a mapping"


def test_a_rule_is_not_front_matter_and_crlf_keeps_offsets() -> None:
    assert mdparse.parse("text\n---\nmore\n---\n").front is None
    text = "---\r\ntitle: x\r\n---\r\nA [[B]]\r\n"
    parsed = mdparse.parse(text)
    link = parsed.links[0]
    assert text[link.target_start : link.target_end] == "B" and link.line == 4


def test_external_and_same_note_links_are_not_links() -> None:
    parsed = mdparse.parse("[a](https://example.com/x.md) [b](mailto:a@example.com) [c](#heading) <https://example.com>")
    assert parsed.links == []


def test_headings_including_inside_quotes() -> None:
    assert mdparse.parse("# One\n> ## Two ##\ntext\n####### seven").headings == [(1, "One"), (2, "Two")]


def test_an_unclosed_backtick_does_not_swallow_the_next_paragraph() -> None:
    parsed = mdparse.parse("a ` stray\n\nnext [[Link]] `closed`")
    assert [link.target for link in parsed.links] == ["Link"]
