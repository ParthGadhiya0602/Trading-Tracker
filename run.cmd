@echo off
REM Windows double-click / terminal launcher. Passes any flags through to run.js.
REM   run.cmd              -> normal
REM   run.cmd --stream --capture
node "%~dp0run.js" %*
