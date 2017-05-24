function moveLink() {
  var d = document.getElementById('unclickable');
  d.style.position = "absolute";
  d.style.left = Math.floor((Math.random() * window.innerWidth) + 1)+'px';
  d.style.top  = Math.floor((Math.random() * window.innerHeight) + 1)+'px';
}
