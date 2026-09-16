import unittest
import tempfile
import shutil
import os
from pathlib import Path
from fastapi.testclient import TestClient

from api.services.file_storage import FileStorageService, is_git_available, storage
from api.main import app


class TestWorkspaceCreate(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.mkdtemp()
        self.storage = FileStorageService(base_dir=".")

    def tearDown(self):
        if os.path.exists(self.temp_dir):
            shutil.rmtree(self.temp_dir, ignore_errors=True)

    def test_git_availability(self):
        res = is_git_available()
        self.assertIsInstance(res, dict)
        self.assertIn("available", res)
        self.assertIn("version", res)

    def test_create_workspace_structure_no_git(self):
        target = os.path.join(self.temp_dir, "my_novel_no_git")
        res = self.storage.create_workspace(target_path=target, init_git=False)

        self.assertTrue(res["success"])
        self.assertEqual(res["path"], str(Path(target).resolve()))
        self.assertFalse(res["git"]["initialized"])

        target_path = Path(target)
        # Check folders
        self.assertTrue((target_path / "chapters").is_dir())
        self.assertTrue((target_path / "characters").is_dir())
        self.assertTrue((target_path / "styles").is_dir())
        self.assertTrue((target_path / "prompts").is_dir())
        self.assertTrue((target_path / "outputs").is_dir())

        # Check essential files
        self.assertTrue((target_path / "chapters" / "CHAPTERS.md").is_file())
        self.assertTrue((target_path / "chapters" / "chapter-1.md").is_file())
        self.assertTrue((target_path / "characters" / "CHARACTERS.md").is_file())
        self.assertTrue((target_path / "characters" / "protagonist.md").is_file())
        self.assertTrue((target_path / "styles" / "STYLES.md").is_file())
        self.assertTrue((target_path / "styles" / "general.md").is_file())
        self.assertTrue((target_path / "styles" / "cinematic.md").is_file())
        self.assertTrue((target_path / "styles" / "superman.md").is_file())
        self.assertTrue((target_path / "story_state.yaml").is_file())

        # Check git was NOT initialized
        self.assertFalse((target_path / ".git").exists())

    def test_create_workspace_with_git(self):
        git_check = is_git_available()
        target = os.path.join(self.temp_dir, "my_novel_git")
        res = self.storage.create_workspace(target_path=target, init_git=True)

        self.assertTrue(res["success"])
        target_path = Path(target)
        if git_check["available"]:
            self.assertTrue(res["git"]["initialized"])
            self.assertTrue((target_path / ".git").exists())
            self.assertTrue((target_path / ".gitignore").is_file())
        else:
            self.assertFalse(res["git"]["initialized"])

    def test_create_workspace_already_tracked_root(self):
        git_check = is_git_available()
        if not git_check["available"]:
            self.skipTest("Git not available")

        # Initialize a git repo first
        import subprocess
        repo_dir = os.path.join(self.temp_dir, "existing_repo")
        os.makedirs(repo_dir, exist_ok=True)
        subprocess.run(["git", "init"], cwd=repo_dir, capture_output=True, check=True)

        # Scaffolding with init_git=True inside existing repo should detect already_tracked
        res = self.storage.create_workspace(target_path=repo_dir, init_git=True)
        self.assertTrue(res["success"])
        self.assertTrue(res["git"]["already_tracked"])
        self.assertFalse(res["git"]["initialized"])
        self.assertIsNotNone(res["git"]["git_parent"])

    def test_create_workspace_already_tracked_nested_subdir(self):
        git_check = is_git_available()
        if not git_check["available"]:
            self.skipTest("Git not available")

        # Initialize a parent git repo
        import subprocess
        parent_repo = os.path.join(self.temp_dir, "parent_repo")
        os.makedirs(parent_repo, exist_ok=True)
        subprocess.run(["git", "init"], cwd=parent_repo, capture_output=True, check=True)

        # Target is a nested subfolder
        nested_target = os.path.join(parent_repo, "subprojects", "novel")
        res = self.storage.create_workspace(target_path=nested_target, init_git=True)
        self.assertTrue(res["success"])
        self.assertTrue(res["git"]["already_tracked"])
        self.assertFalse(res["git"]["initialized"])
        self.assertIsNotNone(res["git"]["git_parent"])
        self.assertFalse((Path(nested_target) / ".git").exists())

    def test_api_git_status(self):
        client = TestClient(app)
        res = client.get("/api/workspace/git-status")
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertIn("available", data)

    def test_api_create_workspace(self):
        client = TestClient(app)
        target = os.path.join(self.temp_dir, "api_workspace")
        res = client.post(
            "/api/workspace/create",
            json={"path": target, "init_git": False, "set_as_active": False}
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertTrue(os.path.exists(target))
        self.assertTrue(os.path.exists(os.path.join(target, "chapters", "CHAPTERS.md")))

    def test_api_create_workspace_relative_path_rejected(self):
        client = TestClient(app)
        # Note: on Windows Path("relative/path").resolve() makes it absolute,
        # but the raw string starts relative. The endpoint expands and resolves,
        # but if someone passes an empty path:
        res = client.post(
            "/api/workspace/create",
            json={"path": "   ", "init_git": False}
        )
        self.assertEqual(res.status_code, 400)

    def test_create_workspace_dot_directory_rejected(self):
        dot_target = os.path.join(self.temp_dir, ".hidden_novel")
        with self.assertRaises(ValueError) as ctx:
            self.storage.create_workspace(target_path=dot_target, init_git=False)
        self.assertIn("not allowed", str(ctx.exception))

    def test_api_create_workspace_dot_directory_rejected(self):
        client = TestClient(app)
        dot_target = os.path.join(self.temp_dir, ".hidden_novel_api")
        res = client.post(
            "/api/workspace/create",
            json={"path": dot_target, "init_git": False}
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("not allowed", res.json()["detail"])

    def test_api_create_workspace_sensitive_path_rejected(self):
        client = TestClient(app)
        sensitive = str(Path.home() / ".ssh" / "my_project")
        res = client.post(
            "/api/workspace/create",
            json={"path": sensitive, "init_git": False}
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("not allowed", res.json()["detail"])

    def test_api_create_workspace_non_empty_dir_rejected_without_force(self):
        client = TestClient(app)
        non_empty = os.path.join(self.temp_dir, "non_empty_dir")
        os.makedirs(non_empty, exist_ok=True)
        Path(non_empty, "existing.txt").write_text("hello", encoding="utf-8")

        res = client.post(
            "/api/workspace/create",
            json={"path": non_empty, "init_git": False, "force": False}
        )
        self.assertEqual(res.status_code, 400)
        self.assertIn("not empty", res.json()["detail"])

    def test_api_create_workspace_non_empty_dir_allowed_with_force(self):
        client = TestClient(app)
        non_empty = os.path.join(self.temp_dir, "non_empty_force")
        os.makedirs(non_empty, exist_ok=True)
        Path(non_empty, "existing.txt").write_text("hello", encoding="utf-8")

        res = client.post(
            "/api/workspace/create",
            json={"path": non_empty, "init_git": False, "force": True, "set_as_active": False}
        )
        self.assertEqual(res.status_code, 200)
        data = res.json()
        self.assertTrue(data["success"])
        self.assertTrue(os.path.exists(os.path.join(non_empty, "chapters", "CHAPTERS.md")))


if __name__ == "__main__":
    unittest.main()

