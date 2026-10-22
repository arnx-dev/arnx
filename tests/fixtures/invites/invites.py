import os

import psycopg


def connect():
    return psycopg.connect(os.environ["DATABASE_URL"], autocommit=True)


def init_db(conn):
    conn.execute("CREATE TABLE IF NOT EXISTS members (team_id int, email text, role text)")
    conn.execute("CREATE TABLE IF NOT EXISTS invites (team_id int, email text)")


def add_member(conn, team_id, email, role):
    conn.execute("INSERT INTO members VALUES (%s, %s, %s)", (team_id, email, role))


def role_of(conn, team_id, email):
    row = conn.execute("SELECT role FROM members WHERE team_id = %s AND email = %s", (team_id, email)).fetchone()
    return row[0] if row else None
