"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const Gtk = require("./Gtk");
const WebKit = require("./WebKit2");
const cast_1 = require("./cast");
Gtk.init(null);
var w = WebKit.WebView.new();
w.vfunc_map();
w.connect("notify::composite-child", (obj, pspec) => {
});
var s = cast_1.giCast(w, Gtk.Widget);
