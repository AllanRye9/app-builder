"""Account endpoints — /api/auth/*. Kept in their own router (rather than
routes.py) since these are the only unauthenticated POST routes in the
whole API besides /api/health; separating them makes that boundary
obvious at a glance.
"""
from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from . import auth

router = APIRouter()


class Credentials(BaseModel):
    email: str = Field(min_length=1, max_length=254)
    password: str = Field(min_length=1, max_length=256)


@router.post("/signup", status_code=201)
async def signup(body: Credentials) -> dict:
    try:
        user, token = await auth.sign_up(body.email, body.password)
    except auth.AuthError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"token": token, "user": auth.user_public(user)}


@router.post("/login")
async def login(body: Credentials) -> dict:
    try:
        user, token = await auth.log_in(body.email, body.password)
    except auth.AuthError as exc:
        raise HTTPException(status_code=401, detail=str(exc)) from exc
    return {"token": token, "user": auth.user_public(user)}


@router.post("/logout")
async def logout(request: Request, user: auth.User = Depends(auth.require_auth)) -> dict:
    token = auth.token_from_request(request)
    if token:
        await auth.log_out(token)
    return {"ok": True}


@router.get("/me")
async def me(user: auth.User = Depends(auth.require_auth)) -> dict:
    return {"user": auth.user_public(user)}
