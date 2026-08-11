$('#td #avator').hover(
	function() {
		$(this).children().attr('src', '../imgs/sprite tiandaossj.png');
		$('#td .aura').show()
	},
	function() {
		$(this).children().attr('src', '../imgs/sprite tiandao.png');
		$('#td .aura').hide()
	}
)
$('#rac #avator').hover(
	function() {
		$(this).children().attr('src', '../imgs/sprite raccoonssj.png');
		$('#rac .aura').show()
	},
	function() {
		$(this).children().attr('src', '../imgs/sprite raccoon.png');
		$('#rac .aura').hide()
	}
)
$('.aura').hide()

$('.left li').hover(
	function() {
		$(this).toggleClass('active')
	})