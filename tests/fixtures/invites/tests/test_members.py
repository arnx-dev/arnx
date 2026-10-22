import invites


def test_role_of():
    conn = invites.connect()
    conn.execute("DROP TABLE IF EXISTS members, invites")
    invites.init_db(conn)
    invites.add_member(conn, 1, "a@x", "admin")
    assert invites.role_of(conn, 1, "a@x") == "admin"
    assert invites.role_of(conn, 1, "b@x") is None
