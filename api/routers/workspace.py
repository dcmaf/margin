from fastapi import APIRouter, HTTPException, UploadFile, File
from fastapi.responses import FileResponse
from typing import List, Dict, Any
from pydantic import BaseModel
from pathlib import Path
import urllib.parse
import urllib.request
import sys
import subprocess
import tempfile
import os
from api.services.file_storage import storage, ALLOWED_IMAGE_EXTS

from api.services.file_storage import (
    storage,
    is_git_available,
    _SENSITIVE_PATH_PREFIXES,
)

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


class CreateFileRequest(BaseModel):
    folder: str
    name: str
    content: str = ""


class CreateWorkspaceRequest(BaseModel):
    path: str
    init_git: bool = False
    set_as_active: bool = True
    force: bool = False


class RenameFileRequest(BaseModel):
    name: str


class UpdateFileRequest(BaseModel):
    content: str


class MediaFromUrlRequest(BaseModel):
    url: str
    name: str = ""


# ---------------------------------------------------------------------------
# Cross-platform folder picker
# ---------------------------------------------------------------------------

def _open_folder_picker() -> str | None:
    """Open a single native folder-picker dialog.

    Uses Tkinter as the primary cross-platform picker (which opens the full
    native Explorer format dialog on Windows and native Cocoa dialog on macOS).
    If cancelled or closed, returns None immediately without popping up any secondary dialog.
    """
    try:
        import tkinter as tk
        from tkinter import filedialog
        root = tk.Tk()
        root.withdraw()          # hide the empty root window
        root.attributes("-topmost", True)
        root.focus_force()
        root.lift()
        path = filedialog.askdirectory(parent=root, title="Select Workspace Folder")
        root.destroy()
        return path or None
    except Exception:
        return None


def _is_subpath(target: Path, base: Path) -> bool:
    """Check if target is the same as or a descendant of base, case-insensitively on Windows."""
    t = str(target.resolve())
    b = str(base.resolve())
    if sys.platform == "win32":
        t = t.lower()
        b = b.lower()
    return t == b or t.startswith(b.rstrip("/\\") + os.sep)


# ---------------------------------------------------------------------------
# Routes
# ---------------------------------------------------------------------------

@router.get("/files")
def get_input_files():
    try:
        return storage.list_input_files()
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


@router.get("/files/{path:path}")
def read_input_file(path: str):
    try:
        decoded_path = urllib.parse.unquote(path)
        content = storage.read_input_file(decoded_path)
        return {"content": content}
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/git-status")
def get_git_status():
    return is_git_available()


@router.get("/pick-folder")
def pick_folder():
    """Open a native folder-picker dialog."""
    path = _open_folder_picker()
    return {"path": path}


@router.post("/create")
def create_workspace_endpoint(req: CreateWorkspaceRequest):
    raw = (req.path or "").strip()
    if not raw:
        raise HTTPException(status_code=400, detail="Workspace path is required.")

    # Expand and resolve to an absolute path
    try:
        resolved = Path(raw).expanduser().resolve()
    except Exception:
        raise HTTPException(status_code=400, detail="Invalid workspace path.")

    if not resolved.is_absolute():
        raise HTTPException(status_code=400, detail="Workspace path must be absolute.")

    # Block sensitive system / dot directories
    if any(part.startswith(".") for part in resolved.parts):
        raise HTTPException(
            status_code=400,
            detail="The selected path is not allowed as a workspace location."
        )

    for blocked in _SENSITIVE_PATH_PREFIXES:
        try:
            blocked_resolved = blocked.expanduser().resolve()
            if _is_subpath(resolved, blocked_resolved):
                raise HTTPException(
                    status_code=400,
                    detail="The selected path is not allowed as a workspace location."
                )
        except HTTPException:
            raise
        except Exception:
            pass

    # Reject non-empty directories unless force=True
    if resolved.exists() and resolved.is_dir() and not req.force:
        try:
            if any(resolved.iterdir()):
                raise HTTPException(
                    status_code=400,
                    detail=(
                        "The selected directory is not empty. "
                        "Pass force=true to scaffold into an existing directory."
                    )
                )
        except HTTPException:
            raise
        except Exception:
            pass

    try:
        res = storage.create_workspace(
            target_path=str(resolved),
            init_git=req.init_git,
        )
        # Link the workspace AFTER scaffold succeeds — a git failure won't leave
        # the app pointing at a half-built directory.
        if req.set_as_active:
            storage.update_settings({"linked_workspace_dir": res["path"]})
            res["set_as_active"] = True
        return res
    except Exception:
        raise HTTPException(status_code=400, detail="Failed to create workspace.")



@router.post("/files")
def create_input_file(req: CreateFileRequest):
    try:
        return storage.create_input_file(req.folder, req.name, req.content)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/files/{path:path}")
def delete_input_file(path: str):
    try:
        decoded_path = urllib.parse.unquote(path)
        storage.delete_input_file(decoded_path)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/files/{path:path}")
def update_input_file(path: str, req: UpdateFileRequest):
    try:
        decoded_path = urllib.parse.unquote(path)
        storage.update_input_file(decoded_path, req.content)
        return {"success": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.patch("/files/{path:path}")
def rename_input_file(path: str, req: RenameFileRequest):
    try:
        decoded_path = urllib.parse.unquote(path)
        return storage.rename_input_file(decoded_path, req.name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/styles")
def get_styles():
    try:
        manifest = storage._load_manifest("styles/STYLES.md")
        styles = []
        for name, desc in manifest.items():
            if not name.lower().endswith(".md"):
                styles.append({
                    "name": name.lower(),
                    "description": desc or ""
                })
        return styles
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


# ---------------------------------------------------------------------------
# Image assets (workspace/assets/) — first-class resources, not LLM payloads
# ---------------------------------------------------------------------------

def _media_error(e: Exception) -> HTTPException:
    msg = str(e)
    if isinstance(e, FileNotFoundError) or "not found" in msg.lower():
        return HTTPException(status_code=404, detail=msg)
    if "Access denied" in msg:
        return HTTPException(status_code=403, detail=msg)
    return HTTPException(status_code=400, detail=msg)


@router.post("/media")
async def upload_media(file: UploadFile = File(...)):
    """Persist an uploaded image to workspace/assets/. Streams to a temp
    file (bounded memory, no app-level size cap — local-first)."""
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".margin-upload")
    try:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            tmp.write(chunk)
        tmp.close()
        return storage.save_media_file(
            tmp.name, file.filename or "", file.content_type or "")
    except Exception as e:
        raise _media_error(e)
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@router.post("/media/from-url")
def upload_media_from_url(req: MediaFromUrlRequest):
    """Fetch a remote image and store it locally so documents never depend
    on external hosts. Streams to a temp file; on failure: 400, and the
    editor inserts nothing."""
    url = (req.url or "").strip()
    if not url.lower().startswith(("http://", "https://")):
        raise HTTPException(status_code=400, detail="URL must be http(s)")
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=".margin-upload")
    try:
        request = urllib.request.Request(
            url, headers={"User-Agent": "margin-writing-app/1.0"})
        with urllib.request.urlopen(request, timeout=20) as resp:  # noqa: S310
            content_type = resp.headers.get("Content-Type", "")
            while True:
                chunk = resp.read(1024 * 1024)
                if not chunk:
                    break
                tmp.write(chunk)
        tmp.close()
        # Derive a display name from the URL path for slug purposes only.
        path_part = urllib.parse.urlparse(url).path.rsplit("/", 1)[-1]
        return storage.save_media_file(tmp.name, req.name or path_part, content_type)
    except HTTPException:
        raise
    except Exception as e:
        raise HTTPException(status_code=400, detail=f"Could not fetch image: {e}")
    finally:
        try:
            os.unlink(tmp.name)
        except OSError:
            pass


@router.get("/media/{path:path}")
def read_media(path: str):
    try:
        decoded_path = urllib.parse.unquote(path)
        full, media_type = storage.read_media(decoded_path)
        return FileResponse(str(full), media_type=media_type)
    except Exception as e:
        raise _media_error(e)
