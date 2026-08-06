"use strict";

const ACTION = Object.freeze({
  CREATE: "create",
  EDIT: "edit",
  REVIEW: "review",
  CLOSE: "close",
  REARM: "rearm",
  DELETE: "delete",
});

function isAlertOperator(user) {
  return !!user && (user.role === "editor" || user.role === "admin");
}

function isCreator(user, alert) {
  return !!user && !!alert && alert.createdByUserId === user.id;
}

function canCreate(user) {
  return isAlertOperator(user);
}

function canReview(user) {
  return isAlertOperator(user);
}

function canEdit(user, alert) {
  return isAlertOperator(user) && isCreator(user, alert);
}

function canClose(user, alert) {
  if (!isAlertOperator(user) || !alert) return false;
  if (isCreator(user, alert)) return true;
  return user.role === "admin" && alert.createdByRole === "editor";
}

function canRearm(user, alert) {
  return canEdit(user, alert);
}

function canDelete(user, alert) {
  return canEdit(user, alert);
}

function authorize(user, action, alert) {
  const allowed =
    action === ACTION.CREATE
      ? canCreate(user)
      : action === ACTION.REVIEW
        ? canReview(user)
        : action === ACTION.EDIT
          ? canEdit(user, alert)
          : action === ACTION.CLOSE
            ? canClose(user, alert)
            : action === ACTION.REARM
              ? canRearm(user, alert)
              : action === ACTION.DELETE
                ? canDelete(user, alert)
                : false;
  return allowed ? null : { error: "alert action not permitted", status: 403 };
}

module.exports = {
  ACTION,
  authorize,
  canCreate,
  canReview,
  canEdit,
  canClose,
  canRearm,
  canDelete,
  isCreator,
};
