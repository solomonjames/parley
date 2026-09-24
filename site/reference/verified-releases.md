# Verified releases

Parley is software that holds authority over your money and calendar, so you should be able to check that what you install is what this repository built. Every release is built and published by GitHub Actions ([`release.yml`](https://github.com/solomonjames/parley/blob/main/.github/workflows/release.yml), [`docker.yml`](https://github.com/solomonjames/parley/blob/main/.github/workflows/docker.yml)) from a tagged commit, with no long-lived publish tokens:

| Artifact | How it's published | Provenance |
|---|---|---|
| npm `parley-protocol` | npm trusted publishing, `--provenance` | npm provenance plus a GitHub build attestation of the `.tgz` |
| PyPI `parley-protocol` | PyPI trusted publishing | GitHub build attestations of the wheel and sdist |
| `ghcr.io/solomonjames/parley` | Docker build on release tags | GitHub build attestation of the image |
| GitHub release | The npm and PyPI artifacts, plus `SHA256SUMS` | |

## Verify

npm, including provenance:

```sh
npm audit signatures
```

A downloaded artifact, against this repository's workflow:

```sh
gh attestation verify parley-protocol-0.1.0.tgz --repo solomonjames/parley
gh attestation verify parley_protocol-0.1.0-py3-none-any.whl --repo solomonjames/parley
```

The container image:

```sh
gh attestation verify oci://ghcr.io/solomonjames/parley:0.1.0 --repo solomonjames/parley
```

Checksums, from the release page:

```sh
sha256sum -c SHA256SUMS
```

A verified attestation tells you the artifact was built by this repository's workflow, from the commit it names. It doesn't tell you the code is correct: for that, there's the [conformance suite](https://github.com/solomonjames/parley/tree/main/conformance), the tests and the [security model](/guide/security).
