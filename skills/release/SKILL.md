---
name: release
description: Validate build, tests and packaging before publishing the npm module.
---
# Release workflow

1. Run `npm install`; commit a lockfile before switching CI to `npm ci`.
2. Run `npm run check` and `npm run pack:check`.
3. Test `examples/basic/` with `curl` GET and POST; check body preservation and upstream failures.
4. Review npm package name availability and ownership; update `package.json` if required.
5. Update version and CHANGELOG using semver.
6. Review `SECURITY.md` and perform dependency audit.
7. Run `npm pack`, inspect tarball, and use `npm publish --access public` only with owner's approval.
8. Tag the release in GitHub and attach changelog.
