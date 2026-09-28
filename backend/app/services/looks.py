"""How a space or folder looks in the sidebar and on the map: a symbol of its own and a colour of its own.

Kept in the database, never in the folders (the vault stays the notes). Anyone who may write in a space may change
them; everybody in it sees the same. A colour holds for the folder and what lies in it, unless a folder below has
one of its own; a symbol only for the folder itself. Moving a folder takes both along; trashing it lets them go.
"""

from __future__ import annotations

from sqlalchemy import delete, or_, select
from sqlalchemy.orm import Session

from ..models import Look, Space

#: The symbols one may choose; the interface draws them (`Symbol.tsx`), the server only knows their names.
ICONS = (
    "folder", "book", "server", "cooking", "travel", "tool", "star", "heart", "home", "work", "code", "music",
    "image", "calendar", "idea", "users", "money", "health", "school", "archive", "lock", "globe", "leaf", "template",
)
#: The colours one may choose: the map's palette and a grey.
COLORS = (
    "#2dd4bf", "#a78bfa", "#fbbf24", "#fb7185", "#38bdf8", "#a3e635", "#fb923c", "#f472b6", "#34d399", "#818cf8",
    "#9a9aa8",
)


class LookError(ValueError):
    pass


def of_spaces(db: Session, space_ids: set[int]) -> dict[str, dict[str, dict[str, str | None]]]:
    """Every look of these spaces: space name, then folder within it ("" for the space itself)."""
    if not space_ids:
        return {}
    out: dict[str, dict[str, dict[str, str | None]]] = {}
    rows = db.execute(
        select(Space.folder, Look.folder, Look.icon, Look.color).join(Space, Space.id == Look.space_id).where(
            Look.space_id.in_(space_ids)
        )
    )
    for space, folder, icon, color in rows:
        out.setdefault(space, {})[folder] = {"icon": icon, "color": color}
    return out


def put(db: Session, space_id: int, folder: str, icon: str | None, color: str | None) -> None:
    """Sets both at once; neither means the look goes back to what nexlore works out."""
    if icon is not None and icon not in ICONS:
        raise LookError("unknown symbol")
    if color is not None and color not in COLORS:
        raise LookError("unknown colour")
    row = db.scalar(select(Look).where(Look.space_id == space_id, Look.folder == folder))
    if icon is None and color is None:
        if row is not None:
            db.delete(row)
        return
    if row is None:
        db.add(Look(space_id=space_id, folder=folder, icon=icon, color=color))
    else:
        row.icon = icon
        row.color = color


def _within(folder: str):
    return or_(Look.folder == folder, Look.folder.startswith(folder + "/", autoescape=True))


def moved(db: Session, space_id: int, old: str, new: str) -> None:
    """A folder moved or renamed within its space (paths without the space): its looks and those below follow."""
    for row in db.scalars(select(Look).where(Look.space_id == space_id, _within(old))):
        row.folder = new + row.folder[len(old) :]


def gone(db: Session, space_id: int, folder: str) -> None:
    """A folder went into the trash: its looks and those below go ("" is the whole space)."""
    if folder == "":
        db.execute(delete(Look).where(Look.space_id == space_id))
    else:
        db.execute(delete(Look).where(Look.space_id == space_id, _within(folder)))
