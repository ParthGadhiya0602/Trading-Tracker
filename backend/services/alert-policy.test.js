"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const policy = require("./alert-policy");

const admin = { id: "admin-1", role: "admin" };
const otherAdmin = { id: "admin-2", role: "admin" };
const editor = { id: "editor-1", role: "editor" };
const otherEditor = { id: "editor-2", role: "editor" };
const viewer = { id: "viewer-1", role: "viewer" };
const adminAlert = {
  createdByUserId: admin.id,
  createdByRole: admin.role,
};
const editorAlert = {
  createdByUserId: editor.id,
  createdByRole: editor.role,
};

test("generic edit, delete, and rearm stay creator-only", () => {
  assert.equal(policy.canEdit(admin, adminAlert), true);
  assert.equal(policy.canDelete(admin, adminAlert), true);
  assert.equal(policy.canRearm(admin, adminAlert), true);
  assert.equal(policy.canEdit(otherAdmin, adminAlert), false);
  assert.equal(policy.canEdit(otherEditor, editorAlert), false);
});

test("admins may edit editor alerts but nobody may edit another admin alert", () => {
  assert.equal(policy.canEditAlert(editor, editorAlert), true);
  assert.equal(policy.canEditAlert(otherEditor, editorAlert), false);
  assert.equal(policy.canEditAlert(admin, editorAlert), true);
  assert.equal(policy.canEditAlert(otherAdmin, adminAlert), false);
  assert.equal(policy.canDelete(admin, editorAlert), false);
  assert.equal(policy.canRearm(admin, editorAlert), false);
});

test("admins may close editor alerts but never another admin alert", () => {
  assert.equal(policy.canClose(admin, editorAlert), true);
  assert.equal(policy.canClose(otherAdmin, adminAlert), false);
  assert.equal(policy.canClose(otherEditor, editorAlert), false);
});

test("admins and editors may review any alert; viewers cannot mutate", () => {
  assert.equal(policy.canReview(admin, editorAlert), true);
  assert.equal(policy.canReview(editor, adminAlert), true);
  assert.equal(policy.canReview(viewer, editorAlert), false);
  assert.equal(policy.canCreate(viewer), false);
  assert.equal(policy.canClose(viewer, editorAlert), false);
});

test("alert creators include only enabled editors and admins", () => {
  const users = [
    { ...admin, username: "Admin", disabled: false },
    { ...editor, username: "Editor", disabled: false },
    { ...viewer, username: "Viewer", disabled: false },
    { id: "editor-disabled", username: "Disabled", role: "editor", disabled: true },
  ];
  assert.deepEqual(policy.eligibleAlertCreators(users), [
    { id: admin.id, username: "Admin", role: "admin" },
    { id: editor.id, username: "Editor", role: "editor" },
  ]);
  assert.equal(policy.resolveAlertCreator(users, editor.id, admin).id, editor.id);
  assert.equal(policy.resolveAlertCreator(users, "", admin).id, admin.id);
  assert.equal(policy.resolveAlertCreator(users, viewer.id, admin), null);
});
