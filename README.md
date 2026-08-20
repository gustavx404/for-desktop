<div align="center">
<h1>
  Stoat for Desktop
  
  [![Stars](https://img.shields.io/github/stars/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/stargazers)
  [![Forks](https://img.shields.io/github/forks/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/network/members)
  [![Pull Requests](https://img.shields.io/github/issues-pr/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/pulls)
  [![Issues](https://img.shields.io/github/issues/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/issues)
  [![Contributors](https://img.shields.io/github/contributors/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/graphs/contributors)
  [![License](https://img.shields.io/github/license/stoatchat/for-desktop?style=flat-square&logoColor=white)](https://github.com/stoatchat/for-desktop/blob/main/LICENSE)
</h1>
Application for Windows, macOS, and Linux.
</div>
<br/>

## Recent Improvements (Linux/Wayland)

This fork includes a round of fixes and optimizations for screen-share audio
on Linux/Wayland, self-hosted server connectivity, and general memory and
performance work across the app:

**Self-hosted server connection**

- Added a landing screen (shown on first launch, or whenever no server is
  configured) to connect to either the official server or a self-hosted
  one, with the self-hosted choice remembered as a "favourite" for one
  click access later.
- Fixed a bug where a self-hosted server would sometimes load but never
  finish mounting its UI, leaving a blank window with no way to retry;
  this is now detected automatically, retried a few times, and falls
  back to the landing screen with a clear notice if it still doesn't load.
- Added a tray menu entry to switch between the official server, the
  saved self-hosted favourite, and to open the landing screen to connect
  to a different server entirely.

**Screen-share audio**

- Fixed screen-share audio not being sent at all on Wayland (Electron's
  `audio: "loopback"` never worked outside Windows).
- Fixed other apps' audio leaking into a share that was supposed to carry
  only one chosen app's audio, and a resulting feedback/echo of the user's
  own voice.
- Fixed audio silently and permanently dropping out after the first working
  share, caused by a race condition in the PipeWire linking logic.
- Added automatic self-healing for PipeWire links that drop intermittently
  (a platform-level flakiness, not something the app can prevent outright),
  so audio recovers within about a second instead of staying broken.
- Replaced adaptive auto-gain control (which made the shared volume drift
  up and down on its own) with a fixed, predictable gain boost.
- Redesigned the "which app's audio to share" picker as an in-app panel
  that follows the app's actual live theme (color, typography, corner
  radius), instead of a generic OS context menu.

**Performance & memory**

- The PipeWire polling loop now fully stops when no screen share is active,
  instead of running unconditionally in the background for the app's
  entire lifetime.
- Fixed several memory leaks: unbounded native icon cache, a Discord RPC
  client whose transport was never closed on reconnect, disconnected but
  still-tracked Web Audio graph nodes, and IPC listeners that could
  outlive the windows/dialogs that registered them.
- Added scheme validation on the server-switching IPC channel to prevent a
  compromised or malicious self-hosted server from navigating the app
  window to a local file.

> These fixes were implemented with the help of AI (Claude, by Anthropic),
> pairing live debugging against a running instance with source-level
> review, to track down and fix issues that don't reproduce reliably by
> reading code alone.

I want to thank the Brazilian Stoat/self-hosted community for surfacing
these issues and testing the fixes live with me — obrigado por ajudar a
deixar isso melhor para todo mundo que usa em português! 🇧🇷
— Gustavo ([@gustavx404](https://github.com/gustavx404))

Thank you so much to everyone who built this app. It's really great, and
it's a pleasure to be able to help and contribute to making it even
better! ❤️
— Gustavo ([@gustavx404](https://github.com/gustavx404))

## Installation

<a href="https://repology.org/project/stoat-desktop/versions">
    <img src="https://repology.org/badge/vertical-allrepos/stoat-desktop.svg" alt="Packaging status" align="right">
</a>

- All downloads and instructions for Stoat can be found on our [Website](https://stoat.chat/download).

## Development Guide

_Contribution guidelines for Desktop app TBA!_

<!-- Before contributing, make yourself familiar with [our contribution guidelines](https://developers.revolt.chat/contrib.html), the [code style guidelines](./GUIDELINES.md), and the [technical documentation for this project](https://revoltchat.github.io/frontend/). -->

Before getting started, you'll want to install:

- [Git](https://git-scm.com/install/)
- [mise-en-place](https://mise.jdx.dev/getting-started.html)

Then proceed to setup:

```bash
# clone the repository
git clone --recursive https://github.com/stoatchat/for-desktop stoat-for-desktop
cd stoat-for-desktop

# Install tools from mise
mise install

# install all packages
mise install:frozen

# start the application
mise dev
# ... or build the bundle
mise build
# ... or build all distributables
mise make
```

Various useful commands for development testing:

```bash
# connect to the development server
mise exec -- pnpm start -- --force-server http://localhost:5173

# test the flatpak (after `make`)
mise exec -- pnpm install:flatpak
mise exec -- pnpm run:flatpak
# ... also connect to dev server like so:
mise exec -- pnpm run:flatpak --force-server http://localhost:5173

# Nix-specific instructions for testing
pnpm package
pnpm run:nix
# ... as before:
pnpm run:nix --force-server=http://localhost:5173
# a better solution would be telling
# Electron Forge where system Electron is
```

### Pulling in Stoat's assets

If you want to pull in Stoat brand assets after pulling, run the following:

```bash
# update the assets
mise assets
```

Currently, this is required to build, any forks are expected to provide their own assets.
