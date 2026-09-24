"""Parley protocol — independent Python implementation (see ../SPEC.md)."""

from ._json import CanonicalError, b64url_decode, b64url_encode, canonical, compact, proposal_hash
from .budget import HandleStore, MemoryHandleStore, fit
from .client import Client, Reply, connect, local
from .errors import ParleyError, fix
from .grants import (
    Grant,
    GrantContext,
    Verification,
    consent_grant,
    decode_grant,
    delegate_grant,
    issue_grant,
    verify_grant,
)
from .keys import KeyPair, generate_key, key_from_seed, sign_proof, verify, verify_proof
from .lens import effect_line, est, fmt_duration, fmt_money, fmt_time, lean, lens, scalar
from .service import (
    Clarification, CommitCtx, Ctx, Plan, Service, charge, clarify, create, money, remove, send, service, update,
)
from .transport import serve_http, serve_stdio, serve_stream, serve_tcp
from .validate import validate_params

__version__ = "0.1.0"

__all__ = [
    "CanonicalError", "Clarification", "Client", "CommitCtx", "Ctx", "Grant", "GrantContext", "HandleStore", "KeyPair",
    "MemoryHandleStore", "ParleyError", "Plan", "Reply", "Service", "Verification", "b64url_decode", "b64url_encode",
    "canonical", "charge", "clarify", "compact", "connect", "consent_grant", "create", "decode_grant", "delegate_grant",
    "effect_line", "est", "fit", "fix", "fmt_duration", "fmt_money", "fmt_time", "generate_key", "issue_grant",
    "key_from_seed", "lean", "lens", "local", "money", "proposal_hash", "remove", "scalar", "send", "serve_http",
    "serve_stdio", "serve_stream", "serve_tcp", "service", "sign_proof", "update", "validate_params", "verify",
    "verify_grant", "verify_proof",
]
