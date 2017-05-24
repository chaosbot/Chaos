(() => {
  const unclickable = document.getElementById('unclickable')
  unclickable.addEventListener('mouseover', () => {
    unclickable.style.position = "absolute"
    unclickable.style.left = `${Math.floor((Math.random() * window.innerWidth) + 1)}px`
    unclickable.style.top = `${Math.floor((Math.random() * window.innerHeight) + 1)}px`
  })
})(document.body)
