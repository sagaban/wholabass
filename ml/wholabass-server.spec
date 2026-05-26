# PyInstaller spec for the wholabass sidecar.
#
# Compiles `server.py` into a single binary that ships inside the
# packaged Tauri app. Heavy ML deps (torch, demucs, basic-pitch,
# librosa, torchcrepe, soundfile, yt-dlp) need explicit hidden-import
# / collect coverage because PyInstaller's static analysis misses
# what they pull in dynamically.
#
# Build via `scripts/build-sidecar.sh`, not by hand — the script
# selects the right output dir + filename triple for the current
# platform.

import sys
from pathlib import Path

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

block_cipher = None

# ---------- Hidden imports ----------
# Modules whose imports are dynamic (importlib, __import__, plugin
# loaders) so PyInstaller misses them by default.
hiddenimports: list[str] = []
hiddenimports += collect_submodules("demucs")
hiddenimports += collect_submodules("basic_pitch")
hiddenimports += collect_submodules("librosa")
hiddenimports += collect_submodules("torchcrepe")
hiddenimports += collect_submodules("yt_dlp")
hiddenimports += collect_submodules("soundfile")
hiddenimports += collect_submodules("torchcodec")
# numba / llvmlite are pulled in by librosa; their submodules are
# loaded lazily.
hiddenimports += collect_submodules("numba")
hiddenimports += collect_submodules("llvmlite")
# sklearn — pulled in by basic-pitch via its model loading helpers.
hiddenimports += collect_submodules("sklearn")
# onnxruntime — basic-pitch[onnx] backend.
hiddenimports += collect_submodules("onnxruntime")

# ---------- Data files ----------
# Files the libraries `pkgutil`-load at runtime: model weights, JSON
# manifests, native libs that aren't ELF/Mach-O binaries.
datas: list[tuple[str, str]] = []
datas += collect_data_files("basic_pitch")  # bundled ONNX/TF model + manifests
datas += collect_data_files("librosa")       # window functions, filters
datas += collect_data_files("torchcrepe")    # CREPE model weights
datas += collect_data_files("soundfile")
datas += collect_data_files("yt_dlp")        # extractor configs
datas += collect_data_files("torchcodec")
# demucs's `remote/*.txt` manifests list which model weights to fetch
# and where their hashes live — without them `get_model()` blows up
# at startup. The actual `.th` weight files stay download-on-first-use
# (~80 MB per model into the user's torch hub cache), but the
# manifests have to ship with the bundle.
datas += collect_data_files("demucs")

a = Analysis(
    ["server.py"],
    pathex=[str(Path.cwd())],
    binaries=[],
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    runtime_hooks=[],
    excludes=[
        # Bench/test deps we don't ship.
        "pytest",
        "ruff",
        "mypy",
        # Jupyter / IPython get pulled in transitively by some ML deps
        # but we never use them at runtime.
        "IPython",
        "jupyter",
        "notebook",
        "matplotlib",  # librosa lists it as optional; we don't plot
    ],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    a.binaries,
    a.zipfiles,
    a.datas,
    [],
    name="wholabass-server",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    upx_exclude=[],
    runtime_tmpdir=None,
    console=True,
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
)
