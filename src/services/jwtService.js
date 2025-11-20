import jwt from "jsonwebtoken"

const SECRET = process.env.JWT_SECRET || "sectret";

export function sign(payload, expires = process.env.JWT_EXPIRES || "7D"){
  return jwt.sign(payload, SECRET, { expiresIn: expires });
}

export function verify(token) {
    return jwt.verify(token, SECRET)
}