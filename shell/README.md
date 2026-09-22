# Rebuilding the local Gumbo app

The canonical installation is `~/Applications/Gumbo.app`. Its bundle identifier is
`ai.scalinity.Gumbo`. Keep the **same signing certificate**, not merely a certificate with
an equivalent display name, when rebuilding. The shell owns macOS permissions, so changing
its signing identity can invalidate those grants.

XcodeGen includes the ignored `shell/signing.local.yml`. On this machine it pins the existing
certificate fingerprint and development team. Preserve that file. Never commit certificate
identifiers, export private keys, replace the identity with ad-hoc signing, or reset TCC as
part of a normal rebuild. If the certificate expires or is unavailable, stop and resolve
signing explicitly rather than silently choosing another identity.

For a new checkout on the same machine, copy the owner's existing local signing configuration.
Its structure is:

```yaml
settings:
  base:
    CODE_SIGN_IDENTITY: "<existing certificate SHA-1 fingerprint>"
    DEVELOPMENT_TEAM: "<existing development team>"
```

With shell builds authorized, run from `shell/`:

```sh
xcodegen generate
xcodebuild -project Gumbo.xcodeproj -scheme Gumbo -configuration Debug \
  -derivedDataPath "$HOME/Library/Caches/Gumbo/Build.noindex" build
```

Before replacing the installed app, compare `codesign -d -r-` for the installed app and
`~/Library/Caches/Gumbo/Build.noindex/Build/Products/Debug/Gumbo.app`. The designated requirements
must match. Verify the new bundle with `codesign --verify --deep --strict`.

Quit Gumbo when no work is active, replace the canonical bundle with the verified build, and
open it again. Keep retired bundles outside Spotlight in a `.noindex` directory. The app starts
the daemon from `~/Documents/Apps/Gumbo` and its localhost dashboard; it is still a local
development installation, not a self-contained release. A checkout elsewhere can set `RepoPath`
in the `ai.scalinity.Gumbo` defaults domain.

Check that the shell keeps its daemon WebSocket connection, then hold Control–Option, speak,
and release. Verify a spoken response and that existing permissions remain granted. Persistent
login/startup behavior belongs to later roadmap work and is not part of this repair.
