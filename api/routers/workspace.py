from fastapi import APIRouter, HTTPException
from typing import List, Dict, Any
from pydantic import BaseModel
import urllib.parse
import sys
import subprocess
from api.services.file_storage import storage

router = APIRouter(prefix="/api/workspace", tags=["workspace"])


class CreateFileRequest(BaseModel):
    folder: str
    name: str
    content: str = ""


class CreateWorkspaceRequest(BaseModel):
    path: str
    init_git: bool = False
    set_as_active: bool = True


class RenameFileRequest(BaseModel):
    name: str


class UpdateFileRequest(BaseModel):
    content: str


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
    except Exception as e:
        print(f"Tkinter folder picker error/not available: {e}")

    # Fallback to CLI tools if Tkinter is not available (e.g. headless Linux)
    try:
        if sys.platform == "darwin":
            result = subprocess.run(
                ["osascript", "-e",
                 'POSIX path of (choose folder with prompt "Select Workspace Folder")'],
                capture_output=True, text=True, timeout=60,
            )
            if result.returncode == 0 and result.stdout.strip():
                return result.stdout.strip()

        elif sys.platform.startswith("linux"):
            # Try zenity (GTK / GNOME), then kdialog (KDE), then yad
            for cmd in [
                ["zenity", "--file-selection", "--directory",
                 "--title=Select Workspace Folder"],
                ["kdialog", "--getexistingdirectory", "."],
                ["yad", "--file", "--directory"],
            ]:
                try:
                    result = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=60,
                    )
                    if result.returncode == 0 and result.stdout.strip():
                        return result.stdout.strip()
                except FileNotFoundError:
                    continue   # binary not installed — try next

    except Exception as e:
        print(f"Native folder picker error: {e}")

    return None


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
    from api.services.file_storage import is_git_available
    return is_git_available()


@router.get("/pick-folder")
def pick_folder():
    """Open a native folder-picker dialog."""
    path = _open_folder_picker()
    return {"path": path}


@router.post("/create")
def create_workspace(req: CreateWorkspaceRequest):
    if not req.path or not req.path.strip():
        raise HTTPException(status_code=400, detail="Workspace path is required")
    try:
        res = storage.create_workspace(
            target_path=req.path.strip(),
            init_git=req.init_git,
            set_as_active=req.set_as_active
        )
        return res
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


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
